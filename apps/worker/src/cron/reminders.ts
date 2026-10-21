import type { WorkerDeps } from "../config";

export const REMINDER_DAYS = 3;

/**
 * Daily: for every quote that expires within the next 3 days and has not been reminded for this expiry date, write an `EXPIRING`
 * event. The worker turns it into the "expiring" notification (email/SMS per the customer's EXPIRING preference). Idempotent: the
 * event payload carries the expiry timestamp, so a re-run, or a rep extending the expiry (new timestamp), behaves correctly.
 */
export async function queueExpiringReminders(deps: WorkerDeps): Promise<{ queued: string[] }> {
  const now = deps.now();
  const horizon = new Date(now.getTime() + REMINDER_DAYS * 86_400_000);
  const quotes = await deps.prisma.quote.findMany({
    where: { shop: deps.config.shop, status: { in: ["QUOTE_READY", "ACCEPTED"] }, expiresAt: { gt: now, lte: horizon }, deletedAt: null },
    select: { id: true, expiresAt: true, currentVersion: true, status: true },
  });
  const queued: string[] = [];
  for (const q of quotes) {
    const expiresAt = q.expiresAt!.toISOString();
    const already = await deps.prisma.event.findFirst({ where: { quoteId: q.id, type: "EXPIRING", payload: { path: ["expiresAt"], equals: expiresAt } }, select: { id: true } });
    if (already) continue;
    await deps.prisma.event.create({
      data: { quoteId: q.id, type: "EXPIRING", actorType: "SYSTEM", payload: { expiresAt, version: q.currentVersion, status: q.status }, createdAt: now },
    });
    queued.push(q.id);
  }
  return { queued };
}
