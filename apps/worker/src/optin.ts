import type { WorkerDeps } from "./config";
import { isSmsOptedOut } from "./inbound";
import { normalizePhone } from "./lib/phone";

/**
 * Texts the one-time opt-in request to numbers a rep added to a quote (`QuoteRecipient` kind SMS, state PENDING, no request sent yet).
 * Consent is the recipient's own: nothing else is ever texted to that number until they reply YES (the inbound hook flips the row
 * to ACTIVE). A number that already replied STOP is never texted. Without Twilio the rows simply wait. Returns how many went out.
 */
export async function sendOptInRequests(deps: WorkerDeps): Promise<number> {
  if (!deps.sms) return 0;
  const pending = await deps.prisma.quoteRecipient.findMany({ where: { kind: "SMS", state: "PENDING", optInRequestedAt: null }, take: 20, orderBy: { createdAt: "asc" } });
  let sent = 0;
  for (const r of pending) {
    const quote = await deps.prisma.quote.findUnique({ where: { id: r.quoteId }, select: { id: true, number: true } });
    if (!quote) continue;
    const now = deps.now();
    if (await isSmsOptedOut(deps.prisma, r.address)) {
      await deps.prisma.quoteRecipient.update({ where: { id: r.id }, data: { state: "OPTED_OUT", optInRequestedAt: now } });
      await deps.prisma.notificationLog.create({ data: { quoteId: quote.id, channel: "SMS", to: r.address, status: "SKIPPED_OPTED_OUT", providerId: null, createdAt: now } });
      continue;
    }
    const who = r.addedByName ? `${r.addedByName} at DSG Distributors` : "DSG Distributors";
    const body = `${who} wants to text you updates about quote Q-${quote.number}. Reply YES to confirm. Reply STOP to opt out. Msg&data rates may apply.`;
    try {
      const res = await deps.sms.send({ to: r.address, body });
      await deps.prisma.notificationLog.create({ data: { quoteId: quote.id, channel: "SMS", to: r.address, status: "SENT", providerId: res.providerId, createdAt: now } });
      await deps.prisma.quoteRecipient.update({ where: { id: r.id }, data: { optInRequestedAt: now } });
      deps.log.info("sms opt-in request sent", { quoteId: quote.id, to: r.address, providerId: res.providerId });
      sent++;
    } catch (e) {
      await deps.prisma.notificationLog.create({ data: { quoteId: quote.id, channel: "SMS", to: r.address, status: "FAILED", providerId: null, createdAt: now } });
      // Do not retry forever: mark as requested so the rep sees "failed" in the log and can use Resend.
      await deps.prisma.quoteRecipient.update({ where: { id: r.id }, data: { optInRequestedAt: now } });
      deps.log.warn("sms opt-in request failed", { quoteId: quote.id, to: r.address, error: (e as Error).message });
    }
  }
  return sent;
}

/** Sent once each time a number newly enrolls in text alerts (carrier-required confirmation). */
export const WELCOME_TEXT =
  "DSG Distributors LLC: You've successfully enrolled in SMS notifications for quotes, orders, shipping updates, and related customer communications. Message frequency varies. Message and data rates may apply. Reply HELP for help or STOP to opt out.";

const WELCOME_STATUSES = ["WELCOME_SENT", "WELCOME_FAILED"];

/**
 * Welcome text for everyone who has enrolled in texts (a preference row with sms on, an opt-in date and a number) and has not yet
 * been welcomed since that opt-in date. Re-enrolling after STOP resets the opt-in date, so they are welcomed again. A failed attempt
 * is logged (WELCOME_FAILED) and not retried until they enroll again. Numbers on the STOP list never get one. Returns how many went out.
 */
export async function sendWelcomeTexts(deps: WorkerDeps): Promise<number> {
  if (!deps.sms) return 0;
  const rows = await deps.prisma.notificationPref.findMany({ where: { sms: true, smsOptInAt: { not: null }, phone: { not: null } }, select: { phone: true, smsOptInAt: true } });
  const enrolled = new Map<string, Date>();
  for (const r of rows) {
    const phone = normalizePhone(r.phone);
    if (!phone || !r.smsOptInAt) continue;
    const prev = enrolled.get(phone);
    if (!prev || r.smsOptInAt > prev) enrolled.set(phone, r.smsOptInAt);
  }
  let sent = 0;
  for (const [phone, optInAt] of enrolled) {
    if (await isSmsOptedOut(deps.prisma, phone)) continue;
    const last = await deps.prisma.notificationLog.findFirst({ where: { channel: "SMS", to: phone, status: { in: WELCOME_STATUSES } }, orderBy: { createdAt: "desc" } });
    if (last && last.createdAt >= optInAt) continue;
    const now = deps.now();
    try {
      const res = await deps.sms.send({ to: phone, body: WELCOME_TEXT });
      await deps.prisma.notificationLog.create({ data: { quoteId: null, channel: "SMS", to: phone, status: "WELCOME_SENT", providerId: res.providerId, createdAt: now } });
      deps.log.info("sms welcome sent", { to: phone, providerId: res.providerId });
      sent++;
    } catch (e) {
      await deps.prisma.notificationLog.create({ data: { quoteId: null, channel: "SMS", to: phone, status: "WELCOME_FAILED", providerId: null, createdAt: now } });
      deps.log.warn("sms welcome failed", { to: phone, error: (e as Error).message });
    }
  }
  return sent;
}
