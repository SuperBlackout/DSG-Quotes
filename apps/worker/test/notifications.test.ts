import { describe, expect, it } from "vitest";
import { processBatch } from "../src/processor";
import { parseReplyAddress } from "../src/lib/reply-token";
import { ProviderError } from "../src/providers/types";
import { CUSTOMER, PHONE, REP_PHONE, logs, mkCustomerPrefs, mkEvent, mkQuote, mkStaff, mkStaffPrefs, mkTeam, useWorker, config } from "./helpers";

const ctx = useWorker();
const ALL = ["QUOTE_RECEIVED", "QUOTE_READY", "NEW_MESSAGE", "CHANGES_REQUESTED", "ACCEPTED", "ORDERED", "EXPIRING"];

async function world() {
  const rep = await mkStaff(ctx.prisma, { name: "Rita Rep", email: "rita@dsg.test" });
  await mkStaffPrefs(ctx.prisma, rep.id, ALL);
  await mkCustomerPrefs(ctx.prisma);
  const quote = await mkQuote(ctx.prisma, { assignedRepId: rep.id });
  return { rep, quote };
}

const emailTo = (to: string) => ctx.email.sent.filter((m) => m.to === to);
const smsTo = (to: string) => ctx.sms.sent.filter((m) => m.to === to);

type Row = { template: string; type: string; actor: "CUSTOMER" | "STAFF" | "SYSTEM"; customer: boolean; sales: boolean; payload?: Record<string, unknown>; msg?: boolean };
// One row per line of the plan's Notifications table. Each must fire on BOTH channels for every audience it names.
const TABLE: Row[] = [
  { template: "submitted", type: "SUBMIT", actor: "CUSTOMER", sales: true, customer: true },
  { template: "quote ready", type: "SEND_REVISION", actor: "STAFF", sales: false, customer: true },
  { template: "new message (customer to sales)", type: "NEW_MESSAGE", actor: "CUSTOMER", sales: true, customer: false, msg: true },
  { template: "new message (sales to customer)", type: "NEW_MESSAGE", actor: "STAFF", sales: false, customer: true, msg: true },
  { template: "changes requested", type: "REQUEST_CHANGES", actor: "CUSTOMER", sales: true, customer: false, payload: { message: "Please drop line 2" } },
  { template: "accepted", type: "ACCEPT", actor: "CUSTOMER", sales: true, customer: true },
  { template: "ordered", type: "ORDER_PLACED", actor: "SYSTEM", sales: true, customer: true },
  { template: "expiring (3-day reminder)", type: "EXPIRING", actor: "SYSTEM", sales: false, customer: true },
  { template: "expired", type: "EXPIRE", actor: "SYSTEM", sales: false, customer: true },
];

describe("notifications table: every row fires on email and SMS", () => {
  it.each(TABLE)("$template ($type)", async (row) => {
    const { quote } = await world();
    const payload = { ...(row.payload ?? {}) };
    if (row.msg) {
      const m = await ctx.prisma.message.create({ data: { quoteId: quote.id, authorType: row.actor === "STAFF" ? "STAFF" : "CUSTOMER", authorName: "Someone", body: "Can you do 10% less?" } });
      payload.messageId = m.id;
    }
    await mkEvent(ctx.prisma, quote.id, row.type, row.actor, payload);
    await processBatch(ctx.deps);

    expect(emailTo("dana@acme.test").length > 0, "customer email").toBe(row.customer);
    expect(smsTo(PHONE).length > 0, "customer sms").toBe(row.customer);
    expect(emailTo("rita@dsg.test").length > 0, "sales email").toBe(row.sales);
    expect(smsTo(REP_PHONE).length > 0, "sales sms").toBe(row.sales);
    // links
    for (const m of ctx.sms.sent) expect(m.body).toMatch(m.to === PHONE ? /dsg\.test\/apps\/quotes\/quotes\// : /admin\.test\/quotes\//);
    // every send is logged with a provider id; nothing is left pending
    const sent = (await logs(ctx.prisma, quote.id)).filter((l) => l.status === "SENT");
    expect(sent.length).toBe(ctx.email.sent.length + ctx.sms.sent.length);
    expect(sent.every((l) => typeof l.providerId === "string")).toBe(true);
    expect(await ctx.prisma.event.count({ where: { notifiedAt: null } })).toBe(0);
  });
});

describe("recipients and preferences", () => {
  it("Reply-To carries a token that identifies the quote and the side", async () => {
    const { quote } = await world();
    await mkEvent(ctx.prisma, quote.id, "SEND_REVISION", "STAFF");
    await processBatch(ctx.deps);
    const parsed = parseReplyAddress(ctx.email.sent[0]!.replyTo!, config.replySecret, config.replyDomain);
    expect(parsed).toEqual({ quoteId: quote.id, role: "c" });
    expect(ctx.email.sent[0]!.replyTo).toMatch(/^q-[a-z0-9]+-c[0-9a-f]{24}@reply\.dsg\.test$/);

    await mkEvent(ctx.prisma, quote.id, "ACCEPT", "CUSTOMER");
    await processBatch(ctx.deps);
    const rep = ctx.email.sent.find((m) => m.to === "rita@dsg.test")!;
    expect(parseReplyAddress(rep.replyTo!, config.replySecret)).toEqual({ quoteId: quote.id, role: "s" });
  });

  it("customers with no saved preferences get email only", async () => {
    const quote = await mkQuote(ctx.prisma);
    await mkEvent(ctx.prisma, quote.id, "SEND_REVISION", "STAFF");
    await processBatch(ctx.deps);
    expect(ctx.email.sent).toHaveLength(1);
    expect(ctx.sms.sent).toHaveLength(0);
  });

  it("respects per-event channel switches", async () => {
    const quote = await mkQuote(ctx.prisma);
    await ctx.prisma.notificationPref.create({ data: { shop: "dsg-test.myshopify.com", customerId: CUSTOMER, event: "QUOTE_READY", email: false, sms: true, phone: PHONE, smsOptInAt: new Date("2026-01-01") } });
    await mkEvent(ctx.prisma, quote.id, "SEND_REVISION", "STAFF");
    await processBatch(ctx.deps);
    expect(ctx.email.sent).toHaveLength(0);
    expect(ctx.sms.sent).toHaveLength(1);
  });

  it("never texts a number without smsOptInAt, even if sms=true on the row", async () => {
    const quote = await mkQuote(ctx.prisma);
    await mkCustomerPrefs(ctx.prisma, { optedIn: false });
    await mkEvent(ctx.prisma, quote.id, "SEND_REVISION", "STAFF");
    await processBatch(ctx.deps);
    expect(ctx.email.sent).toHaveLength(1);
    expect(ctx.sms.sent).toHaveLength(0);
  });

  it("watchers get email copies of customer-facing alerts, never SMS, never sales alerts", async () => {
    const quote = await mkQuote(ctx.prisma, { watchers: ["sam@acme.test"] });
    await mkCustomerPrefs(ctx.prisma);
    await mkEvent(ctx.prisma, quote.id, "SEND_REVISION", "STAFF");
    await processBatch(ctx.deps);
    expect(emailTo("sam@acme.test")).toHaveLength(1);
    expect(ctx.sms.sent.map((m) => m.to)).toEqual([PHONE]);
    await mkEvent(ctx.prisma, quote.id, "REQUEST_CHANGES", "CUSTOMER", { message: "x" });
    await processBatch(ctx.deps);
    expect(emailTo("sam@acme.test")).toHaveLength(1);
  });

  it("unassigned quote goes to the team, else managers, else the fallback address", async () => {
    const a = await mkStaff(ctx.prisma, { email: "a@dsg.test" });
    const b = await mkStaff(ctx.prisma, { email: "b@dsg.test" });
    await mkStaff(ctx.prisma, { email: "boss@dsg.test", role: "manager" });
    await mkStaff(ctx.prisma, { email: "gone@dsg.test", role: "admin", active: false });
    const team = await mkTeam(ctx.prisma, "East", [a.id, b.id]);
    const q1 = await mkQuote(ctx.prisma, { teamId: team.id, status: "SUBMITTED" });
    await mkEvent(ctx.prisma, q1.id, "SUBMIT", "CUSTOMER");
    await processBatch(ctx.deps);
    expect(ctx.email.sent.map((m) => m.to).filter((t) => t.endsWith("@dsg.test")).sort()).toEqual(["a@dsg.test", "b@dsg.test"]);
    ctx.email.sent.length = 0;
    const q2 = await mkQuote(ctx.prisma, { status: "SUBMITTED" });
    await mkEvent(ctx.prisma, q2.id, "SUBMIT", "CUSTOMER");
    await processBatch(ctx.deps);
    expect(ctx.email.sent.map((m) => m.to)).toContain("boss@dsg.test");
    expect(ctx.email.sent.map((m) => m.to)).not.toContain("gone@dsg.test"); // inactive staff are never notified
    expect(a.id).toBeTruthy();
    await ctx.prisma.staff.deleteMany();
    ctx.email.sent.length = 0;
    ctx.deps.config.salesFallbackEmail = "sales@dsg.test";
    const q3 = await mkQuote(ctx.prisma, { status: "SUBMITTED" });
    await mkEvent(ctx.prisma, q3.id, "SUBMIT", "CUSTOMER");
    await processBatch(ctx.deps);
    expect(ctx.email.sent.map((m) => m.to)).toContain("sales@dsg.test");
  });

  it("ignores events with no notification (CREATE, ASSIGN, ...) but marks them processed", async () => {
    const quote = await mkQuote(ctx.prisma);
    await mkEvent(ctx.prisma, quote.id, "ASSIGN", "STAFF");
    await processBatch(ctx.deps);
    expect(ctx.email.sent).toHaveLength(0);
    expect(await ctx.prisma.event.count({ where: { notifiedAt: null } })).toBe(0);
  });

  it("SMS is skipped (and logged) when Twilio is not configured", async () => {
    const { quote } = await world();
    ctx.deps.sms = null;
    await mkEvent(ctx.prisma, quote.id, "SEND_REVISION", "STAFF");
    await processBatch(ctx.deps);
    expect(ctx.email).toBeTruthy();
    const l = await logs(ctx.prisma, quote.id);
    expect(l.some((x) => x.channel === "SMS" && x.status === "SKIPPED_SMS_DISABLED")).toBe(true);
  });
});

describe("internal messages never notify customers (CLAUDE.md rule 5)", () => {
  it("a (forged) NEW_MESSAGE event pointing at an internal note sends nothing and is consumed", async () => {
    const { quote } = await world();
    const note = await ctx.prisma.message.create({ data: { quoteId: quote.id, authorType: "STAFF", body: "margin is thin", internal: true } });
    await mkEvent(ctx.prisma, quote.id, "NEW_MESSAGE", "STAFF", { messageId: note.id });
    await processBatch(ctx.deps);
    expect(ctx.email.sent).toHaveLength(0);
    expect(ctx.sms.sent).toHaveLength(0);
    expect(await ctx.prisma.event.count({ where: { notifiedAt: null } })).toBe(0);
  });

  it("an internal note bundled with a public message is left out of the alert", async () => {
    const { quote } = await world();
    const pub = await ctx.prisma.message.create({ data: { quoteId: quote.id, authorType: "STAFF", authorName: "Rita", body: "public reply" } });
    const note = await ctx.prisma.message.create({ data: { quoteId: quote.id, authorType: "STAFF", authorName: "Rita", body: "SECRET COST NOTE", internal: true } });
    await mkEvent(ctx.prisma, quote.id, "NEW_MESSAGE", "STAFF", { messageId: pub.id });
    await mkEvent(ctx.prisma, quote.id, "NEW_MESSAGE", "STAFF", { messageId: note.id });
    await processBatch(ctx.deps);
    const all = JSON.stringify([ctx.email.sent, ctx.sms.sent]);
    expect(all).toContain("public reply");
    expect(all).not.toContain("SECRET COST NOTE");
  });
});

describe("NEW_MESSAGE bundling (5 minute window)", () => {
  const say = async (quoteId: string, body: string, actor: "CUSTOMER" | "STAFF" = "STAFF") => {
    const m = await ctx.prisma.message.create({ data: { quoteId, authorType: actor, authorName: actor === "STAFF" ? "Rita" : "Dana", body, createdAt: new Date(ctx.clock.now) } });
    await mkEvent(ctx.prisma, quoteId, "NEW_MESSAGE", actor, { messageId: m.id }, new Date(ctx.clock.now));
  };

  it("first message goes out immediately; the burst after it leaves as one alert after the window", async () => {
    const { quote } = await world();
    await say(quote.id, "first");
    await processBatch(ctx.deps);
    expect(emailTo("dana@acme.test")).toHaveLength(1);

    ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
    await say(quote.id, "second");
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000);
    await say(quote.id, "third");
    await processBatch(ctx.deps);
    await processBatch(ctx.deps);
    expect(emailTo("dana@acme.test")).toHaveLength(1); // still held

    ctx.clock.now = new Date(ctx.clock.now.getTime() + 6 * 60_000);
    await processBatch(ctx.deps);
    const mails = emailTo("dana@acme.test");
    expect(mails).toHaveLength(2);
    expect(mails[1]!.subject).toMatch(/2 new messages/);
    expect(mails[1]!.text).toContain("second");
    expect(mails[1]!.text).toContain("third");
    expect(smsTo(PHONE)).toHaveLength(2);
    expect(smsTo(PHONE)[1]!.body).toMatch(/2 new messages/);
    expect(await ctx.prisma.event.count({ where: { notifiedAt: null } })).toBe(0);
  });

  it("bundles per quote and per side", async () => {
    const { quote } = await world();
    const other = await mkQuote(ctx.prisma);
    await say(quote.id, "a");
    await say(other.id, "b");
    await say(quote.id, "from customer", "CUSTOMER");
    await processBatch(ctx.deps);
    expect(emailTo("dana@acme.test")).toHaveLength(2); // one per quote (customer side)
    expect(emailTo("rita@dsg.test")).toHaveLength(1); // customer's message reaches sales independently
  });
});

describe("quiet hours defer SMS only", () => {
  it("email sends now; SMS waits for the end of the window, then goes", async () => {
    const { quote } = await world();
    await ctx.prisma.notificationPref.updateMany({ where: { customerId: CUSTOMER }, data: { quietStart: "09:00", quietEnd: "12:00" } }); // 10:00 ET is inside
    await mkEvent(ctx.prisma, quote.id, "SEND_REVISION", "STAFF");
    await processBatch(ctx.deps);
    expect(emailTo("dana@acme.test")).toHaveLength(1);
    expect(ctx.sms.sent).toHaveLength(0);
    const deferred = await ctx.prisma.event.findFirstOrThrow({ where: { type: "SMS_DEFERRED" } });
    expect(deferred.notifiedAt).toBeNull();
    expect((deferred.payload as any).sendAfter).toBe("2026-03-02T17:00:00.000Z"); // 12:00 EST

    ctx.clock.now = new Date("2026-03-02T16:30:00Z");
    await processBatch(ctx.deps);
    expect(ctx.sms.sent).toHaveLength(0);
    ctx.clock.now = new Date("2026-03-02T17:00:01Z");
    await processBatch(ctx.deps);
    expect(ctx.sms.sent).toHaveLength(1);
    const l = (await logs(ctx.prisma, quote.id)).filter((x) => x.channel === "SMS" && x.status === "SENT");
    expect(l).toHaveLength(1);
    expect(l[0]!.providerId).toBe("fake-sms-1");
    expect(await ctx.prisma.event.count({ where: { type: "SMS_DEFERRED" } })).toBe(0); // queue entry consumed
    expect(await ctx.prisma.event.count({ where: { notifiedAt: null } })).toBe(0);
  });

  it("a deferred text is dropped if the customer opted out while it waited", async () => {
    const { quote } = await world();
    await ctx.prisma.notificationPref.updateMany({ where: { customerId: CUSTOMER }, data: { quietStart: "09:00", quietEnd: "12:00" } });
    await mkEvent(ctx.prisma, quote.id, "SEND_REVISION", "STAFF");
    await processBatch(ctx.deps);
    await ctx.prisma.notificationPref.updateMany({ where: { customerId: CUSTOMER }, data: { sms: false, smsOptInAt: null } });
    ctx.clock.now = new Date("2026-03-02T18:00:00Z");
    await processBatch(ctx.deps);
    expect(ctx.sms.sent).toHaveLength(0);
  });
});

describe("delivery robustness", () => {
  it("two workers racing on the same events never double-send", async () => {
    const { quote } = await world();
    const quotes = [quote, await mkQuote(ctx.prisma), await mkQuote(ctx.prisma)];
    for (const q of quotes) await mkEvent(ctx.prisma, q.id, "SEND_REVISION", "STAFF");
    await Promise.all([processBatch(ctx.deps), processBatch(ctx.deps), processBatch(ctx.deps)]);
    await processBatch(ctx.deps); // anything skipped as busy
    expect(emailTo("dana@acme.test")).toHaveLength(3);
    expect(smsTo(PHONE)).toHaveLength(3);
    expect(await ctx.prisma.event.count({ where: { notifiedAt: null } })).toBe(0);
  });

  it("a transient provider failure retries with backoff and never re-sends to recipients already served", async () => {
    const { quote } = await world();
    ctx.email.failFor.set("dana@acme.test", new ProviderError("boom", true));
    await mkEvent(ctx.prisma, quote.id, "ACCEPT", "CUSTOMER");
    await processBatch(ctx.deps);
    expect(emailTo("rita@dsg.test")).toHaveLength(1);
    expect(emailTo("dana@acme.test")).toHaveLength(0);
    expect(await ctx.prisma.event.count({ where: { type: "ACCEPT", notifiedAt: null } })).toBe(1);

    await processBatch(ctx.deps); // inside the backoff window: nothing
    ctx.email.failFor.clear();
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 61_000);
    await processBatch(ctx.deps);
    expect(emailTo("dana@acme.test")).toHaveLength(1);
    expect(emailTo("rita@dsg.test")).toHaveLength(1);
    expect(smsTo(PHONE)).toHaveLength(1);
    expect(smsTo(REP_PHONE)).toHaveLength(1);
    expect(await ctx.prisma.event.count({ where: { notifiedAt: null } })).toBe(0);
  });

  it("a permanent failure is logged as FAILED and not retried", async () => {
    const { quote } = await world();
    ctx.email.failFor.set("dana@acme.test", new ProviderError("inactive recipient", false, 406));
    await mkEvent(ctx.prisma, quote.id, "SEND_REVISION", "STAFF");
    await processBatch(ctx.deps);
    const l = await logs(ctx.prisma, quote.id);
    expect(l.some((x) => x.status === "FAILED" && x.channel === "EMAIL" && x.to === "dana@acme.test")).toBe(true);
    expect(await ctx.prisma.event.count({ where: { notifiedAt: null } })).toBe(0);
  });

  it("gives up after maxAttempts", async () => {
    const { quote } = await world();
    ctx.email.failWith = new ProviderError("down", true);
    await mkEvent(ctx.prisma, quote.id, "SEND_REVISION", "STAFF");
    for (let i = 0; i < 5; i++) {
      await processBatch(ctx.deps);
      ctx.clock.now = new Date(ctx.clock.now.getTime() + 10 * 60_000);
    }
    expect(await ctx.prisma.event.count({ where: { notifiedAt: null } })).toBe(0);
  });

  it("Twilio 'unsubscribed' (21610) revokes consent in our records", async () => {
    const { quote } = await world();
    ctx.sms.failFor.set(PHONE, new ProviderError("21610", false, 21610));
    await mkEvent(ctx.prisma, quote.id, "SEND_REVISION", "STAFF");
    await processBatch(ctx.deps);
    const prefs = await ctx.prisma.notificationPref.findMany({ where: { customerId: CUSTOMER } });
    expect(prefs.every((p) => !p.sms && p.smsOptInAt === null)).toBe(true);
  });

  it("sends are logged in NotificationLog and nothing else is added to the quote timeline", async () => {
    const { quote } = await world();
    await mkEvent(ctx.prisma, quote.id, "SEND_REVISION", "STAFF");
    await processBatch(ctx.deps);
    const types = new Set((await ctx.prisma.event.findMany({ where: { quoteId: quote.id } })).map((e) => e.type));
    expect([...types]).toEqual(["SEND_REVISION"]);
    const l = await logs(ctx.prisma, quote.id);
    expect(l.map((x) => `${x.channel}:${x.to}:${x.status}`).sort()).toEqual(["EMAIL:dana@acme.test:SENT", `SMS:${PHONE}:SENT`]);
  });
});
