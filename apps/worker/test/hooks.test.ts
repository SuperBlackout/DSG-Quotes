import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hookRoutes, type HookOptions } from "../../api/src/hooks";
import { ApiError } from "../../api/src/errors";
import { replyAddress } from "../src/lib/reply-token";
import { twilioSignature } from "../src/lib/twilio-signature";
import { processBatch } from "../src/processor";
import { CUSTOMER, PHONE, REP_PHONE, SHOP, config, mkCustomerPrefs, mkQuote, mkStaff, mkStaffPrefs, useWorker } from "./helpers";

const ctx = useWorker();
const TOKEN = "pm-inbound-token";
const TWILIO = "twilio-auth-token";
const URL_ = "https://dsg.test/hooks/twilio-inbound";
const opts: HookOptions = { postmarkInboundToken: TOKEN, twilioAuthToken: TWILIO, twilioWebhookUrl: URL_, replySecret: config.replySecret, replyDomain: config.replyDomain, supportEmail: "help@dsg.test" };

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  app.decorate("deps", {
    config: { shopDomain: SHOP },
    get prisma() {
      return ctx.prisma;
    },
    now: () => new Date(ctx.clock.now),
  } as any);
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) return reply.status(err.httpStatus).send(err.toBody());
    return reply.status(500).send({ message: String(err) });
  });
  await app.register(hookRoutes, { prefix: "/hooks", ...opts });
  await app.ready();
});
afterAll(() => app.close());

const basic = (pw: string) => `Basic ${Buffer.from(`pm:${pw}`).toString("base64")}`;
const mail = (to: string, from: string, text: string, extra: Record<string, unknown> = {}, pw = TOKEN) =>
  app.inject({ method: "POST", url: "/hooks/email-inbound", headers: { authorization: basic(pw), "content-type": "application/json" }, payload: { From: from, FromFull: { Email: from }, ToFull: [{ Email: to }], To: to, TextBody: text, MessageID: `m-${Math.random()}`, ...extra } });
const sms = (params: Record<string, string>, sig?: string) => {
  const p = { MessageSid: `SM${Math.random()}`, ...params };
  return app.inject({
    method: "POST",
    url: "/hooks/twilio-inbound",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig ?? twilioSignature(TWILIO, URL_, p) },
    payload: new URLSearchParams(p).toString(),
  });
};
const addr = (quoteId: string, role: "c" | "s") => replyAddress({ secret: config.replySecret, domain: config.replyDomain, quoteId, role });

describe("POST /hooks/email-inbound", () => {
  it("rejects missing or wrong credentials", async () => {
    const q = await mkQuote(ctx.prisma);
    expect((await mail(addr(q.id, "c"), "dana@acme.test", "hi", {}, "wrong")).statusCode).toBe(401);
    const r = await app.inject({ method: "POST", url: "/hooks/email-inbound", payload: {} });
    expect(r.statusCode).toBe(401);
    expect(await ctx.prisma.message.count()).toBe(0);
  });

  it("customer reply: strips quoted text, posts a CUSTOMER message on channel EMAIL, emits NEW_MESSAGE that notifies sales", async () => {
    const rep = await mkStaff(ctx.prisma);
    await mkStaffPrefs(ctx.prisma, rep.id, ["NEW_MESSAGE"]);
    const q = await mkQuote(ctx.prisma, { assignedRepId: rep.id });
    const r = await mail(addr(q.id, "c"), "Dana <dana@acme.test>", "Looks good, can you ship Friday?\n\nOn Mon, Mar 2, 2026 at 3:00 PM DSG Quotes <q@dsg.direct> wrote:\n> Your quote is ready", { FromFull: { Email: "dana@acme.test" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().result).toBe("posted");
    const m = await ctx.prisma.message.findFirstOrThrow({ where: { quoteId: q.id } });
    expect(m).toMatchObject({ authorType: "CUSTOMER", channel: "EMAIL", internal: false, body: "Looks good, can you ship Friday?", authorId: CUSTOMER });
    const ev = await ctx.prisma.event.findFirstOrThrow({ where: { quoteId: q.id, type: "NEW_MESSAGE" } });
    expect(ev).toMatchObject({ actorType: "CUSTOMER", notifiedAt: null });

    await processBatch(ctx.deps);
    expect(ctx.email.sent.map((x) => x.to)).toEqual(["rita@dsg.test"]);
    expect(ctx.email.sent[0]!.text).toContain("ship Friday");
  });

  it("staff reply via email posts a STAFF (non-internal) message that notifies the customer", async () => {
    const rep = await mkStaff(ctx.prisma);
    const q = await mkQuote(ctx.prisma, { assignedRepId: rep.id });
    await mkCustomerPrefs(ctx.prisma);
    expect((await mail(addr(q.id, "s"), "RITA@dsg.test", "Yes, Friday works.")).json().result).toBe("posted");
    expect(await ctx.prisma.message.findFirstOrThrow({ where: { quoteId: q.id } })).toMatchObject({ authorType: "STAFF", authorName: "Rita Rep", internal: false, channel: "EMAIL" });
    await processBatch(ctx.deps);
    expect(ctx.email.sent.map((x) => x.to)).toEqual(["dana@acme.test"]);
    expect(ctx.sms.sent.map((x) => x.to)).toEqual([PHONE]);
  });

  it("ignores: forged token, unknown quote, stranger sender, customer token used by staff address, auto-replies, empty, duplicates", async () => {
    const q = await mkQuote(ctx.prisma, { watchers: ["sam@acme.test"] });
    const forged = `q-${q.id}-c${"0".repeat(24)}@${config.replyDomain}`;
    expect((await mail(forged, "dana@acme.test", "hi")).json().result).toBe("no_valid_reply_address");
    expect((await mail(addr("nosuchquote", "c"), "dana@acme.test", "hi")).json().result).toBe("unknown_quote");
    expect((await mail(addr(q.id, "c"), "stranger@evil.test", "hi")).json().result).toBe("sender_not_on_quote");
    expect((await mail(addr(q.id, "s"), "dana@acme.test", "hi")).json().result).toBe("sender_not_staff");
    expect((await mail(addr(q.id, "c"), "dana@acme.test", "ooo", { Headers: [{ Name: "Auto-Submitted", Value: "auto-replied" }] })).json().result).toBe("auto_reply_ignored");
    expect((await mail(addr(q.id, "c"), "dana@acme.test", "> only a quote")).json().result).toBe("empty_reply");
    expect(await ctx.prisma.message.count()).toBe(0);

    await mail(addr(q.id, "c"), "dana@acme.test", "once", { MessageID: "same" });
    expect((await mail(addr(q.id, "c"), "dana@acme.test", "once", { MessageID: "same" })).json().result).toBe("duplicate");
    expect(await ctx.prisma.message.count()).toBe(1);
  });

  it("a watcher can reply", async () => {
    const q = await mkQuote(ctx.prisma, { watchers: ["sam@acme.test"] });
    expect((await mail(addr(q.id, "c"), "sam@acme.test", "Sam here")).json().result).toBe("posted");
    expect((await ctx.prisma.message.findFirstOrThrow({ where: { quoteId: q.id } })).authorName).toBe("sam@acme.test");
  });
});

describe("POST /hooks/twilio-inbound", () => {
  async function textedCustomer() {
    const rep = await mkStaff(ctx.prisma);
    await mkStaffPrefs(ctx.prisma, rep.id, ["NEW_MESSAGE", "QUOTE_READY"]);
    await mkCustomerPrefs(ctx.prisma);
    const q = await mkQuote(ctx.prisma, { assignedRepId: rep.id });
    await ctx.prisma.event.create({ data: { quoteId: q.id, type: "SEND_REVISION", actorType: "STAFF", payload: {} } });
    await processBatch(ctx.deps); // texts the customer; writes the NOTIFICATION log row the reply is matched against
    ctx.email.sent.length = 0;
    return { q, rep };
  }

  it("rejects a bad or missing signature", async () => {
    const r1 = await sms({ From: PHONE, Body: "hi" }, "bogus");
    expect(r1.statusCode).toBe(401);
    const p = { From: PHONE, Body: "hi", MessageSid: "SMx" };
    const r2 = await app.inject({ method: "POST", url: "/hooks/twilio-inbound", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams(p).toString() });
    expect(r2.statusCode).toBe(401);
  });

  it("a reply to an alert text posts a SMS message into that quote and emits NEW_MESSAGE", async () => {
    const { q } = await textedCustomer();
    const r = await sms({ From: PHONE, To: "+15550000000", Body: "Can you do 10% less?" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/xml");
    const m = await ctx.prisma.message.findFirstOrThrow({ where: { quoteId: q.id } });
    expect(m).toMatchObject({ authorType: "CUSTOMER", channel: "SMS", internal: false, body: "Can you do 10% less?" });
    await processBatch(ctx.deps);
    expect(ctx.email.sent.map((x) => x.to)).toEqual(["rita@dsg.test"]);
  });

  it("STOP stores the opt-out: consent cleared, no further SMS, replies no longer accepted", async () => {
    const { q } = await textedCustomer();
    const r = await sms({ From: PHONE, Body: "STOP" });
    expect(r.statusCode).toBe(200);
    const prefs = await ctx.prisma.notificationPref.findMany({ where: { customerId: CUSTOMER } });
    expect(prefs.length).toBeGreaterThan(0);
    expect(prefs.every((p) => p.smsOptInAt === null && p.sms === false)).toBe(true);
    // Source of truth + history
    expect(await ctx.prisma.smsOptOut.findUniqueOrThrow({ where: { phone: PHONE } })).toMatchObject({ source: "twilio-stop" });
    expect((await ctx.prisma.notificationLog.findMany({ where: { to: PHONE, status: "OPTED_OUT" } })).map((l) => l.quoteId)).toEqual([q.id]);

    ctx.sms.sent.length = 0;
    await ctx.prisma.event.create({ data: { quoteId: q.id, type: "SEND_REVISION", actorType: "STAFF", payload: {} } });
    await processBatch(ctx.deps);
    expect(ctx.sms.sent).toHaveLength(0);
    expect(ctx.email.sent.some((m) => m.to === "dana@acme.test")).toBe(true); // email unaffected

    await sms({ From: PHONE, Body: "hello?" });
    expect(await ctx.prisma.message.count()).toBe(0);
  });

  it("after STOP, saving the settings again does not re-consent: the number stays blocked until the customer texts START", async () => {
    const { q } = await textedCustomer();
    await sms({ From: PHONE, Body: "STOP" });
    // What PUT /c/notification-prefs does on a re-save with the SMS box ticked: a fresh opt-in timestamp on every row.
    await ctx.prisma.notificationPref.updateMany({ where: { customerId: CUSTOMER }, data: { sms: true, smsOptInAt: new Date(ctx.clock.now), phone: PHONE } });
    ctx.sms.sent.length = 0;
    await ctx.prisma.event.create({ data: { quoteId: q.id, type: "SEND_REVISION", actorType: "STAFF", payload: {} } });
    await processBatch(ctx.deps);
    expect(ctx.sms.sent).toHaveLength(0);
    expect((await ctx.prisma.notificationLog.findMany({ where: { quoteId: q.id, channel: "SMS" }, orderBy: { createdAt: "asc" } })).map((l) => l.status)).toContain("SKIPPED_OPTED_OUT");
    expect((await sms({ From: PHONE, Body: "hello?" })).body).toContain("could not match");
    expect(await ctx.prisma.message.count()).toBe(0);

    // START lifts the block (history stays), and the (re-given) consent then works again.
    await sms({ From: PHONE, Body: "START" });
    expect(await ctx.prisma.smsOptOut.count()).toBe(0);
    expect(await ctx.prisma.notificationLog.count({ where: { to: PHONE, status: { in: ["OPTED_OUT", "OPTED_IN_START"] } } })).toBe(2);
    await ctx.prisma.event.create({ data: { quoteId: q.id, type: "SEND_REVISION", actorType: "STAFF", payload: {} } });
    await processBatch(ctx.deps);
    expect(ctx.sms.sent).toHaveLength(1);
  });

  it("STOP also clears staff texting rows", async () => {
    const rep = await mkStaff(ctx.prisma, { phone: REP_PHONE });
    await mkStaffPrefs(ctx.prisma, rep.id, ["QUOTE_RECEIVED"]);
    await sms({ From: REP_PHONE, Body: "stop" });
    expect((await ctx.prisma.notificationPref.findMany({ where: { staffId: rep.id } })).every((p) => p.smsOptInAt === null)).toBe(true);
  });

  it("HELP answers with TwiML and changes nothing", async () => {
    const { q } = await textedCustomer();
    const r = await sms({ From: PHONE, Body: "HELP" });
    expect(r.body).toContain("<Message>");
    expect(r.body).toContain("STOP");
    expect(await ctx.prisma.message.count({ where: { quoteId: q.id } })).toBe(0);
    expect((await ctx.prisma.notificationPref.findFirstOrThrow({ where: { customerId: CUSTOMER } })).smsOptInAt).not.toBeNull();
  });

  it("an unknown number gets a polite reply and nothing is posted", async () => {
    await mkQuote(ctx.prisma);
    const r = await sms({ From: "+19998887777", Body: "who is this" });
    expect(r.body).toContain("could not match");
    expect(await ctx.prisma.message.count()).toBe(0);
  });

  it("a rep can answer by SMS", async () => {
    const rep = await mkStaff(ctx.prisma);
    await mkStaffPrefs(ctx.prisma, rep.id, ["QUOTE_RECEIVED"]);
    const q = await mkQuote(ctx.prisma, { assignedRepId: rep.id, status: "SUBMITTED" });
    await ctx.prisma.event.create({ data: { quoteId: q.id, type: "SUBMIT", actorType: "CUSTOMER", payload: {} } });
    await processBatch(ctx.deps);
    await sms({ From: REP_PHONE, Body: "On it" });
    expect(await ctx.prisma.message.findFirstOrThrow({ where: { quoteId: q.id } })).toMatchObject({ authorType: "STAFF", channel: "SMS", body: "On it" });
  });

  it("duplicate MessageSid is ignored", async () => {
    const { q } = await textedCustomer();
    const p = { From: PHONE, Body: "once", MessageSid: "SMdup" };
    const send = () => app.inject({ method: "POST", url: "/hooks/twilio-inbound", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(TWILIO, URL_, p) }, payload: new URLSearchParams(p).toString() });
    await send();
    await send();
    expect(await ctx.prisma.message.count({ where: { quoteId: q.id } })).toBe(1);
  });
});

describe("registration", () => {
  it("routes exist only when their credential is configured (fail closed)", async () => {
    const bare = Fastify();
    bare.decorate("deps", { config: { shopDomain: SHOP }, prisma: ctx.prisma, now: () => new Date() } as any);
    await bare.register(hookRoutes, { prefix: "/hooks", replySecret: "s", replyDomain: "d" });
    expect((await bare.inject({ method: "POST", url: "/hooks/email-inbound", payload: {} })).statusCode).toBe(404);
    expect((await bare.inject({ method: "POST", url: "/hooks/twilio-inbound", payload: {} })).statusCode).toBe(404);
    await bare.close();
  });
});

describe("numbers a rep added to one quote", () => {
  const EXTRA = "+15165550142";
  const add = (quoteId: string, state: string) => ctx.prisma.quoteRecipient.create({ data: { quoteId, kind: "SMS", address: EXTRA, name: "Bo Buyer", state, addedByName: "Rita" } });

  it("YES confirms the pending number; STOP then marks it stopped", async () => {
    const quote = await mkQuote(ctx.prisma);
    await add(quote.id, "PENDING");
    const yes = await sms({ From: EXTRA, Body: "YES" });
    expect(yes.body).toContain("successfully enrolled in SMS notifications");
    expect(await ctx.prisma.notificationLog.count({ where: { to: EXTRA, status: "WELCOME_SENT" } })).toBe(1);
    expect(await ctx.prisma.quoteRecipient.findFirstOrThrow({ where: { quoteId: quote.id } })).toMatchObject({ state: "ACTIVE" });
    await sms({ From: EXTRA, Body: "STOP" });
    expect(await ctx.prisma.quoteRecipient.findFirstOrThrow({ where: { quoteId: quote.id } })).toMatchObject({ state: "OPTED_OUT" });
  });

  it("a confirmed number's reply lands in the quote conversation under its name; an unconfirmed one is ignored", async () => {
    const quote = await mkQuote(ctx.prisma);
    await ctx.prisma.notificationLog.create({ data: { quoteId: quote.id, channel: "SMS", to: EXTRA, status: "SENT", providerId: "SM1" } });
    await add(quote.id, "PENDING");
    await sms({ From: EXTRA, Body: "Can you do 5% less?" });
    expect(await ctx.prisma.message.count({ where: { quoteId: quote.id } })).toBe(0);
    await ctx.prisma.quoteRecipient.updateMany({ where: { quoteId: quote.id }, data: { state: "ACTIVE" } });
    await sms({ From: EXTRA, Body: "Can you do 5% less?" });
    const m = await ctx.prisma.message.findFirstOrThrow({ where: { quoteId: quote.id } });
    expect(m).toMatchObject({ authorType: "CUSTOMER", authorName: "Bo Buyer", body: "Can you do 5% less?", channel: "SMS" });
  });
});
