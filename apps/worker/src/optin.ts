import type { WorkerDeps } from "./config";
import { isSmsOptedOut } from "./inbound";

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
