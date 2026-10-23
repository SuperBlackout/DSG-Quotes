import { describe, expect, it } from "vitest";
import { WELCOME_TEXT, sendOptInRequests, sendWelcomeTexts } from "../src/optin";
import { processBatch } from "../src/processor";
import { mkEvent, mkQuote, useWorker } from "./helpers";

const ctx = useWorker();
const PHONE2 = "+15165550142";

const addExtra = (quoteId: string, kind: "EMAIL" | "SMS", address: string, state = "ACTIVE") =>
  ctx.prisma.quoteRecipient.create({ data: { quoteId, kind, address, name: "Bo Buyer", state, addedByName: "Rita Rep" } });

describe("extra recipients on one quote", () => {
  it("an added email gets the customer-side alert; a removed or never-added one does not", async () => {
    const quote = await mkQuote(ctx.prisma);
    await addExtra(quote.id, "EMAIL", "bo@buyer.test");
    await mkEvent(ctx.prisma, quote.id, "SEND_REVISION", "STAFF");
    await processBatch(ctx.deps);
    expect(ctx.email.sent.map((m) => m.to)).toContain("bo@buyer.test");
  });

  it("an ACTIVE number is texted, a PENDING one is not", async () => {
    const quote = await mkQuote(ctx.prisma);
    await addExtra(quote.id, "SMS", PHONE2, "PENDING");
    await mkEvent(ctx.prisma, quote.id, "SEND_REVISION", "STAFF");
    await processBatch(ctx.deps);
    expect(ctx.sms.sent.filter((m) => m.to === PHONE2)).toHaveLength(0);

    await ctx.prisma.quoteRecipient.updateMany({ where: { quoteId: quote.id }, data: { state: "ACTIVE" } });
    await mkEvent(ctx.prisma, quote.id, "SEND_REVISION", "STAFF");
    await processBatch(ctx.deps);
    expect(ctx.sms.sent.filter((m) => m.to === PHONE2)).toHaveLength(1);
  });

  it("an ACTIVE number that is in SmsOptOut is never texted", async () => {
    const quote = await mkQuote(ctx.prisma);
    await addExtra(quote.id, "SMS", PHONE2);
    await ctx.prisma.smsOptOut.create({ data: { phone: PHONE2, source: "twilio-stop" } });
    await mkEvent(ctx.prisma, quote.id, "SEND_REVISION", "STAFF");
    await processBatch(ctx.deps);
    expect(ctx.sms.sent.filter((m) => m.to === PHONE2)).toHaveLength(0);
  });
});

describe("opt-in request text", () => {
  it("is sent once to a pending number and says who asked and how to confirm or stop", async () => {
    const quote = await mkQuote(ctx.prisma);
    const r = await addExtra(quote.id, "SMS", PHONE2, "PENDING");
    expect(await sendOptInRequests(ctx.deps)).toBe(1);
    const m = ctx.sms.sent.find((x) => x.to === PHONE2)!;
    expect(m.body).toContain(`Q-${quote.number}`);
    expect(m.body).toContain("Rita Rep");
    expect(m.body).toMatch(/YES/);
    expect(m.body).toMatch(/STOP/);
    expect((await ctx.prisma.quoteRecipient.findUniqueOrThrow({ where: { id: r.id } })).optInRequestedAt).not.toBeNull();
    expect(await sendOptInRequests(ctx.deps)).toBe(0); // not again until the rep presses Resend
    expect(await ctx.prisma.notificationLog.count({ where: { quoteId: quote.id, to: PHONE2, status: "SENT" } })).toBe(1);
  });

  it("a number that replied STOP is marked stopped and not texted", async () => {
    const quote = await mkQuote(ctx.prisma);
    const r = await addExtra(quote.id, "SMS", PHONE2, "PENDING");
    await ctx.prisma.smsOptOut.create({ data: { phone: PHONE2, source: "twilio-stop" } });
    expect(await sendOptInRequests(ctx.deps)).toBe(0);
    expect(ctx.sms.sent).toHaveLength(0);
    expect((await ctx.prisma.quoteRecipient.findUniqueOrThrow({ where: { id: r.id } })).state).toBe("OPTED_OUT");
  });
});

describe("welcome text after enrolling", () => {
  const enroll = (phone: string, optInAt: Date) =>
    ctx.prisma.notificationPref.create({ data: { shop: "dsg-test.myshopify.com", customerId: "gid://shopify/Customer/777", event: "NEW_MESSAGE", email: true, sms: true, phone, smsOptInAt: optInAt } });

  it("is sent once per enrollment with the exact wording, and again after re-enrolling", async () => {
    await enroll(PHONE2, new Date("2026-01-01T00:00:00Z"));
    expect(await sendWelcomeTexts(ctx.deps)).toBe(1);
    const m = ctx.sms.sent.find((x) => x.to === PHONE2)!;
    expect(m.body).toBe(WELCOME_TEXT);
    expect(m.body).toContain("Reply HELP for help or STOP to opt out");
    expect(await sendWelcomeTexts(ctx.deps)).toBe(0); // not again

    await ctx.prisma.notificationPref.updateMany({ data: { smsOptInAt: new Date("2030-01-01T00:00:00Z") } }); // opted in again later
    expect(await sendWelcomeTexts(ctx.deps)).toBe(1);
  });

  it("is never sent to a number on the STOP list or one that has not opted in", async () => {
    await enroll(PHONE2, new Date("2026-01-01T00:00:00Z"));
    await ctx.prisma.smsOptOut.create({ data: { phone: PHONE2, source: "twilio-stop" } });
    await ctx.prisma.notificationPref.create({ data: { shop: "dsg-test.myshopify.com", customerId: "gid://shopify/Customer/778", event: "NEW_MESSAGE", email: true, sms: true, phone: "+15165550177", smsOptInAt: null } });
    expect(await sendWelcomeTexts(ctx.deps)).toBe(0);
    expect(ctx.sms.sent).toHaveLength(0);
  });
});
