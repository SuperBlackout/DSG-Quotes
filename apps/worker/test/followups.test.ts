import { describe, expect, it } from "vitest";
import { runCron } from "../src/cron/run";
import { sendWeeklySummaries } from "../src/cron/weekly";
import { planFor } from "../src/rules";
import { processBatch } from "../src/processor";
import { CUSTOMER, PHONE, REP_PHONE, SHOP, logs, mkCustomerPrefs, mkEvent, mkQuote, mkStaff, mkStaffPrefs, useWorker } from "./helpers";

const ctx = useWorker();
const emailTo = (to: string) => ctx.email.sent.filter((m) => m.to === to);
const MONDAY = new Date("2026-03-09T13:30:00Z"); // 09:30 ET, Monday (DST already in effect)

const watcher = (o: Record<string, unknown> = {}) => ({ email: "sam@acme.test", name: "Sam", role: "PM", scope: "all", channels: { email: true, sms: false }, ...o });
const setWatchers = (watchers: unknown[]) => ctx.prisma.customerProfile.create({ data: { shop: SHOP, customerId: CUSTOMER, email: "dana@acme.test", watchers: watchers as object } });
const job = (name = "Lakeview") => ctx.prisma.job.create({ data: { shop: SHOP, companyId: "gid://shopify/Company/1", name, createdById: CUSTOMER } });

describe("WRK-1: the seven preference keys", () => {
  it("maps events to keys: SUBMIT -> QUOTE_RECEIVED, SEND_REVISION -> QUOTE_READY, staff message -> NEW_MESSAGE, 3-day reminder -> EXPIRING, ORDER_PLACED -> ORDERED, ACCEPT -> ACCEPTED", () => {
    const key = (t: string, a: "CUSTOMER" | "STAFF" | "SYSTEM" = "SYSTEM") => planFor(t, a)?.customerPrefKey;
    expect(key("SUBMIT", "CUSTOMER")).toBe("QUOTE_RECEIVED");
    expect(key("SEND_REVISION", "STAFF")).toBe("QUOTE_READY");
    expect(key("NEW_MESSAGE", "STAFF")).toBe("NEW_MESSAGE");
    expect(key("EXPIRING")).toBe("EXPIRING");
    expect(key("ORDER_PLACED")).toBe("ORDERED");
    expect(key("ACCEPT", "CUSTOMER")).toBe("ACCEPTED");
  });

  it("REQUEST_CHANGES and FLOOR_APPROVAL_REQUESTED have no customer key and never target the customer side", () => {
    expect(planFor("REQUEST_CHANGES", "CUSTOMER")).toMatchObject({ customerPrefKey: null, sides: ["sales"] });
    expect(planFor("FLOOR_APPROVAL_REQUESTED", "STAFF")).toMatchObject({ customerPrefKey: null, sides: ["managers"] });
  });

  it("the submit confirmation follows QUOTE_RECEIVED; the old SUBMITTED key means nothing", async () => {
    const q = await mkQuote(ctx.prisma, { status: "SUBMITTED" });
    await mkCustomerPrefs(ctx.prisma, { events: ["QUOTE_RECEIVED"], email: false, sms: false });
    await mkEvent(ctx.prisma, q.id, "SUBMIT", "CUSTOMER");
    await processBatch(ctx.deps);
    expect(emailTo("dana@acme.test")).toHaveLength(0);

    await ctx.prisma.notificationPref.deleteMany();
    await mkCustomerPrefs(ctx.prisma, { events: ["SUBMITTED"], email: false, sms: false }); // legacy row: ignored, defaults apply
    await mkEvent(ctx.prisma, q.id, "SUBMIT", "CUSTOMER");
    await processBatch(ctx.deps);
    expect(emailTo("dana@acme.test")).toHaveLength(1);
  });

  it("a customer who switched ORDERED off but kept ACCEPTED on only hears about the accept", async () => {
    const q = await mkQuote(ctx.prisma);
    await ctx.prisma.notificationPref.createMany({
      data: [
        { shop: SHOP, customerId: CUSTOMER, event: "ORDERED", email: false, sms: false },
        { shop: SHOP, customerId: CUSTOMER, event: "ACCEPTED", email: true, sms: false },
      ],
    });
    await mkEvent(ctx.prisma, q.id, "ORDER_PLACED", "SYSTEM");
    await mkEvent(ctx.prisma, q.id, "ACCEPT", "CUSTOMER");
    await processBatch(ctx.deps);
    expect(ctx.email.sent.map((m) => m.subject)).toEqual([expect.stringContaining("accepted")]);
  });
});

describe("WRK-3: watchers honour scope and channels", () => {
  it("scope all follows every quote; a job scope follows only that job's quotes", async () => {
    const lake = await job("Lakeview");
    const other = await job("Harbor");
    await setWatchers([watcher({ email: "all@acme.test", scope: "all" }), watcher({ email: "lake@acme.test", scope: lake.id })]);
    const inLake = await mkQuote(ctx.prisma, { jobId: lake.id });
    const inOther = await mkQuote(ctx.prisma, { jobId: other.id });
    const noJob = await mkQuote(ctx.prisma);

    await mkEvent(ctx.prisma, inLake.id, "SEND_REVISION", "STAFF");
    await processBatch(ctx.deps);
    expect(ctx.email.sent.map((m) => m.to).sort()).toEqual(["all@acme.test", "dana@acme.test", "lake@acme.test"]);

    ctx.email.sent.length = 0;
    await mkEvent(ctx.prisma, inOther.id, "SEND_REVISION", "STAFF");
    await mkEvent(ctx.prisma, noJob.id, "SEND_REVISION", "STAFF");
    await processBatch(ctx.deps);
    expect(emailTo("lake@acme.test")).toHaveLength(0);
    expect(emailTo("all@acme.test")).toHaveLength(2);
  });

  it("a watcher with the email channel off gets no email, and never sales-side alerts", async () => {
    await setWatchers([watcher({ channels: { email: false, sms: false } }), watcher({ email: "on@acme.test" })]);
    const q = await mkQuote(ctx.prisma);
    await mkEvent(ctx.prisma, q.id, "SEND_REVISION", "STAFF");
    await mkEvent(ctx.prisma, q.id, "REQUEST_CHANGES", "CUSTOMER", { message: "x" });
    await processBatch(ctx.deps);
    expect(emailTo("sam@acme.test")).toHaveLength(0);
    expect(emailTo("on@acme.test")).toHaveLength(1); // quote ready only; the change request is a sales alert
  });

  it("a watcher's SMS request sends nothing (no number or opt-in of their own); the owner's SMS is unaffected", async () => {
    await mkCustomerPrefs(ctx.prisma);
    await setWatchers([watcher({ channels: { email: true, sms: true } })]);
    const q = await mkQuote(ctx.prisma);
    await mkEvent(ctx.prisma, q.id, "SEND_REVISION", "STAFF");
    await processBatch(ctx.deps);
    expect(emailTo("sam@acme.test")).toHaveLength(1);
    expect(ctx.sms.sent.map((m) => m.to)).toEqual([PHONE]);
  });

  it("watchers stay silent for an event the owner has switched off on every channel", async () => {
    await setWatchers([watcher()]);
    await ctx.prisma.notificationPref.create({ data: { shop: SHOP, customerId: CUSTOMER, event: "QUOTE_READY", email: false, sms: false } });
    const q = await mkQuote(ctx.prisma);
    await mkEvent(ctx.prisma, q.id, "SEND_REVISION", "STAFF");
    await processBatch(ctx.deps);
    expect(ctx.email.sent).toHaveLength(0);
  });

  it("quote-level watchers (plain emails) still work and do not need a scope", async () => {
    const q = await mkQuote(ctx.prisma, { watchers: ["quote-level@acme.test"] });
    await mkEvent(ctx.prisma, q.id, "SEND_REVISION", "STAFF");
    await processBatch(ctx.deps);
    expect(emailTo("quote-level@acme.test")).toHaveLength(1);
  });
});

describe("WRK-4: FLOOR_APPROVAL_REQUESTED", () => {
  const payload = (lineIds: string[], o: Record<string, unknown> = {}) => ({ lineIds, costUnknownLineIds: [], note: "Customer is a big account", requester: { id: "x", name: "Rita Rep" }, ...o });

  it("emails active managers and admins only: not the rep, not reps' teammates, not inactive staff, never the customer", async () => {
    const rep = await mkStaff(ctx.prisma, { name: "Rita Rep", email: "rita@dsg.test" });
    await mkStaff(ctx.prisma, { name: "Mia Manager", email: "mia@dsg.test", role: "manager" });
    await mkStaff(ctx.prisma, { name: "Al Admin", email: "al@dsg.test", role: "admin" });
    await mkStaff(ctx.prisma, { name: "Old Boss", email: "old@dsg.test", role: "manager", active: false });
    await mkStaff(ctx.prisma, { name: "Other Rep", email: "other@dsg.test" });
    await mkCustomerPrefs(ctx.prisma);
    const q = await mkQuote(ctx.prisma, { assignedRepId: rep.id, status: "IN_REVIEW" });
    const line = await ctx.prisma.quoteLine.create({ data: { quoteId: q.id, set: "STAFF", variantId: "gid://shopify/ProductVariant/1", sku: "SKU-9", title: "Widget", qty: 2, listPrice: "100", quotedPrice: "80", cost: "79", position: 0 } });
    const unknown = await ctx.prisma.quoteLine.create({ data: { quoteId: q.id, set: "STAFF", variantId: "gid://shopify/ProductVariant/2", sku: "SKU-10", title: "Gadget", qty: 1, listPrice: "10", quotedPrice: "9", position: 1 } });
    await mkEvent(ctx.prisma, q.id, "FLOOR_APPROVAL_REQUESTED", "STAFF", payload([line.id, unknown.id], { costUnknownLineIds: [unknown.id] }));
    await processBatch(ctx.deps);

    expect(ctx.email.sent.map((m) => m.to).sort()).toEqual(["al@dsg.test", "mia@dsg.test"]);
    expect(ctx.sms.sent).toHaveLength(0);
    const m = ctx.email.sent[0]!;
    expect(m.subject).toContain(`Q-${q.number}`);
    expect(m.text).toContain("Rita Rep");
    expect(m.text).toContain("SKU-9 Widget");
    expect(m.text).toContain("1 with unknown cost");
    expect(m.text).toContain("Customer is a big account");
    expect(m.text).toContain("admin.test/quotes/");
    expect(m.text).not.toMatch(/79|margin|cost:/i); // no cost or margin numbers
    expect(m.replyTo).toMatch(/-s[0-9a-f]+@/);
    expect(await ctx.prisma.event.count({ where: { notifiedAt: null } })).toBe(0);
    expect((await logs(ctx.prisma, q.id)).filter((l) => l.status === "SENT")).toHaveLength(2);
  });

  it("when the requester is a manager the other managers are told, and when nobody else exists the fallback address gets it", async () => {
    const mia = await mkStaff(ctx.prisma, { email: "mia@dsg.test", role: "manager" });
    const q = await mkQuote(ctx.prisma, { assignedRepId: mia.id, status: "IN_REVIEW" });
    ctx.deps.config.salesFallbackEmail = "sales@dsg.test";
    await ctx.prisma.event.create({ data: { quoteId: q.id, type: "FLOOR_APPROVAL_REQUESTED", actorType: "STAFF", actorId: mia.id, payload: payload([]) } });
    await processBatch(ctx.deps);
    expect(ctx.email.sent.map((m) => m.to)).toEqual(["sales@dsg.test"]);

    ctx.email.sent.length = 0;
    await mkStaff(ctx.prisma, { email: "al@dsg.test", role: "admin" });
    await ctx.prisma.event.create({ data: { quoteId: q.id, type: "FLOOR_APPROVAL_REQUESTED", actorType: "STAFF", actorId: mia.id, payload: payload([]) } });
    await processBatch(ctx.deps);
    expect(ctx.email.sent.map((m) => m.to)).toEqual(["al@dsg.test"]);
  });

  it("a manager can opt into text alerts with a staff preference row", async () => {
    const mia = await mkStaff(ctx.prisma, { email: "mia@dsg.test", role: "manager" });
    await mkStaffPrefs(ctx.prisma, mia.id, ["FLOOR_APPROVAL_REQUESTED"]);
    const q = await mkQuote(ctx.prisma, { status: "IN_REVIEW" });
    await mkEvent(ctx.prisma, q.id, "FLOOR_APPROVAL_REQUESTED", "STAFF", payload([]));
    await processBatch(ctx.deps);
    expect(ctx.sms.sent.map((m) => m.to)).toEqual([REP_PHONE]);
    expect(ctx.sms.sent[0]!.body).toContain("floor approval");
  });
});

describe("WRK-2: Monday WEEKLY_SUMMARY", () => {
  it("does not run on other days, or before 8:00 ET; runs once on Monday", async () => {
    await mkQuote(ctx.prisma, { expiresAt: new Date("2026-04-30T00:00:00Z") });
    ctx.clock.now = new Date("2026-03-10T13:30:00Z"); // Tuesday
    expect((await runCron(ctx.deps)).weeklySent).toBe(0);
    ctx.clock.now = new Date("2026-03-09T11:30:00Z"); // Monday 07:30 ET
    expect((await runCron(ctx.deps)).weeklySent).toBe(0);
    ctx.clock.now = new Date(MONDAY);
    expect((await runCron(ctx.deps)).weeklySent).toBe(1);
    ctx.clock.now = new Date("2026-03-09T18:30:00Z");
    expect((await runCron(ctx.deps)).weeklySent).toBe(0); // same Monday, later run
    expect(ctx.email.sent.filter((m) => m.subject.startsWith("Your weekly quote summary"))).toHaveLength(1);
    ctx.clock.now = new Date("2026-03-16T13:30:00Z");
    expect((await runCron(ctx.deps)).weeklySent).toBe(1); // next Monday
  });

  it("lists only the customer's open, non-expired quotes (no drafts, no finished ones), once per customer, with customer-visible figures", async () => {
    ctx.clock.now = new Date(MONDAY);
    const ready = await mkQuote(ctx.prisma, { title: "Lakeview Clinic", status: "QUOTE_READY", total: "1234.50", marginPct: "3.2", workingInternalNote: "SECRET margin note" } as object);
    await mkQuote(ctx.prisma, { title: "Waiting on us", status: "SUBMITTED" });
    await mkQuote(ctx.prisma, { title: "Scratch draft", status: "DRAFT" });
    await mkQuote(ctx.prisma, { title: "Bought already", status: "ORDERED" });
    await mkQuote(ctx.prisma, { title: "Lapsed", status: "QUOTE_READY", expiresAt: new Date("2026-03-01T00:00:00Z") });
    await mkQuote(ctx.prisma, { title: "Someone else's", customerId: "gid://shopify/Customer/2", customerEmail: "eve@other.test", status: "QUOTE_READY" });

    const r = await sendWeeklySummaries(ctx.deps);
    expect(r).toEqual({ sent: 2, failed: 0 });
    const mine = emailTo("dana@acme.test");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.subject).toBe("Your weekly quote summary: 2 open quotes");
    expect(mine[0]!.text).toContain("Lakeview Clinic");
    expect(mine[0]!.text).toContain("$1,234.50");
    expect(mine[0]!.text).toContain("Waiting on us");
    expect(mine[0]!.text).toContain(`dsg.test/apps/quotes/quotes/${ready.id}`);
    for (const t of ["Scratch draft", "Bought already", "Lapsed", "Someone else", "SECRET", "3.2"]) expect(mine[0]!.text + mine[0]!.html).not.toContain(t);
    expect(emailTo("eve@other.test")).toHaveLength(1);
    // every send is in NotificationLog with the provider id (no quote)
    const rows = await ctx.prisma.notificationLog.findMany({ where: { quoteId: null, channel: "EMAIL" } });
    expect(rows.map((l) => l.to).sort()).toEqual(["dana@acme.test", "eve@other.test"]);
    expect(rows.every((l) => l.status === "SENT" && !!l.providerId)).toBe(true);
  });

  it("is off when the customer turned WEEKLY_SUMMARY email off, and sends nothing to a customer with no open quotes", async () => {
    ctx.clock.now = new Date(MONDAY);
    await mkQuote(ctx.prisma);
    await ctx.prisma.notificationPref.create({ data: { shop: SHOP, customerId: CUSTOMER, event: "WEEKLY_SUMMARY", email: false, sms: false } });
    await setWatchers([watcher()]);
    expect(await sendWeeklySummaries(ctx.deps)).toEqual({ sent: 0, failed: 0 }); // owner off => watchers too
    await ctx.prisma.notificationPref.deleteMany();
    await ctx.prisma.quote.deleteMany();
    await mkQuote(ctx.prisma, { status: "DECLINED" });
    expect(await sendWeeklySummaries(ctx.deps)).toEqual({ sent: 0, failed: 0 });
  });

  it("watchers get the summary limited to their scope and channels", async () => {
    ctx.clock.now = new Date(MONDAY);
    const lake = await job("Lakeview");
    await setWatchers([watcher({ email: "all@acme.test" }), watcher({ email: "lake@acme.test", scope: lake.id }), watcher({ email: "muted@acme.test", channels: { email: false, sms: true } })]);
    await mkQuote(ctx.prisma, { title: "In the lake job", jobId: lake.id });
    await mkQuote(ctx.prisma, { title: "Elsewhere" });
    await sendWeeklySummaries(ctx.deps);
    expect(emailTo("all@acme.test")[0]!.text).toMatch(/In the lake job[\s\S]*Elsewhere|Elsewhere[\s\S]*In the lake job/);
    const lakeMail = emailTo("lake@acme.test")[0]!.text;
    expect(lakeMail).toContain("In the lake job");
    expect(lakeMail).not.toContain("Elsewhere");
    expect(emailTo("muted@acme.test")).toHaveLength(0);
    expect(emailTo("dana@acme.test")).toHaveLength(1);
  });
});

describe("SmsOptOut and NotificationLog in the sender", () => {
  const world = async () => {
    await mkCustomerPrefs(ctx.prisma);
    return mkQuote(ctx.prisma);
  };

  it("a number in SmsOptOut is never texted even with sms=true and a fresh opt-in on file; the skip is logged, email still goes", async () => {
    const q = await world();
    await ctx.prisma.smsOptOut.create({ data: { phone: PHONE, source: "twilio-stop" } });
    await mkEvent(ctx.prisma, q.id, "SEND_REVISION", "STAFF");
    await processBatch(ctx.deps);
    expect(ctx.sms.sent).toHaveLength(0);
    expect(emailTo("dana@acme.test")).toHaveLength(1);
    expect((await logs(ctx.prisma, q.id)).map((l) => `${l.channel}:${l.status}`).sort()).toEqual(["EMAIL:SENT", "SMS:SKIPPED_OPTED_OUT"]);
  });

  it("a Twilio 21610 error writes SmsOptOut (source twilio-21610) and history, and the next alert skips SMS", async () => {
    const q = await world();
    const { ProviderError } = await import("../src/providers/types");
    ctx.sms.failFor.set(PHONE, new ProviderError("21610", false, 21610));
    await mkEvent(ctx.prisma, q.id, "SEND_REVISION", "STAFF");
    await processBatch(ctx.deps);
    expect(await ctx.prisma.smsOptOut.findUniqueOrThrow({ where: { phone: PHONE } })).toMatchObject({ source: "twilio-21610" });
    ctx.sms.failFor.clear();
    await ctx.prisma.notificationPref.updateMany({ where: { customerId: CUSTOMER }, data: { sms: true, smsOptInAt: new Date("2026-03-01") } }); // re-saved settings
    await mkEvent(ctx.prisma, q.id, "ACCEPT", "CUSTOMER");
    await processBatch(ctx.deps);
    expect(ctx.sms.sent).toHaveLength(0);
  });

  it("a deferred (quiet hours) text is dropped when the number lands in SmsOptOut while it waits", async () => {
    const q = await world();
    await ctx.prisma.notificationPref.updateMany({ where: { customerId: CUSTOMER }, data: { quietStart: "09:00", quietEnd: "12:00" } });
    await mkEvent(ctx.prisma, q.id, "SEND_REVISION", "STAFF");
    await processBatch(ctx.deps);
    expect((await logs(ctx.prisma, q.id)).some((l) => l.status === "SKIPPED_QUIET_HOURS")).toBe(true);
    await ctx.prisma.smsOptOut.create({ data: { phone: PHONE, source: "admin" } });
    ctx.clock.now = new Date("2026-03-02T18:00:00Z");
    await processBatch(ctx.deps);
    expect(ctx.sms.sent).toHaveLength(0);
    expect(await ctx.prisma.event.count({ where: { type: "SMS_DEFERRED" } })).toBe(0);
    expect((await logs(ctx.prisma, q.id)).some((l) => l.status === "SKIPPED_OPTED_OUT")).toBe(true);
  });

  it("the rep digest is logged too (no quote)", async () => {
    ctx.clock.now = new Date("2026-03-03T13:05:00Z");
    const rep = await mkStaff(ctx.prisma);
    await mkQuote(ctx.prisma, { status: "SUBMITTED", assignedRepId: rep.id });
    await runCron(ctx.deps);
    const rows = await ctx.prisma.notificationLog.findMany({ where: { quoteId: null, to: "rita@dsg.test" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: "EMAIL", status: "SENT" });
  });

  it("an inactive rep is skipped in favour of the managers", async () => {
    const gone = await mkStaff(ctx.prisma, { email: "gone@dsg.test", active: false });
    await mkStaff(ctx.prisma, { email: "mia@dsg.test", role: "manager" });
    const q = await mkQuote(ctx.prisma, { status: "SUBMITTED", assignedRepId: gone.id });
    await mkEvent(ctx.prisma, q.id, "SUBMIT", "CUSTOMER");
    await processBatch(ctx.deps);
    expect(ctx.email.sent.map((m) => m.to)).toContain("mia@dsg.test");
    expect(ctx.email.sent.map((m) => m.to)).not.toContain("gone@dsg.test");
  });
});
