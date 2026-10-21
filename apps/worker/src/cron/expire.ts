import { canTransition } from "shared";
// The API's sanctioned status writer: calls shared transition() and inserts the `events` row in the caller's transaction
// (CLAUDE.md rule 1). Imported rather than re-implemented so there is exactly one place that writes Quote.status.
import { applyTransition, lockQuote } from "../../../api/src/domain/transitions";
import type { WorkerDeps } from "../config";

/**
 * Hourly: move quotes whose `expiresAt` has passed to EXPIRED (QUOTE_READY and ACCEPTED-but-not-yet-ordered, per the state machine).
 * One transaction per quote: lock the row, re-check under the lock, transition + events row. The EXPIRE event then flows through the
 * normal queue, so the customer gets the "expired" notice per their preferences.
 */
export async function expireDueQuotes(deps: WorkerDeps): Promise<{ expired: string[] }> {
  const now = deps.now();
  const due = await deps.prisma.quote.findMany({
    where: { shop: deps.config.shop, status: { in: ["QUOTE_READY", "ACCEPTED"] }, expiresAt: { lte: now }, deletedAt: null },
    select: { id: true },
    orderBy: { expiresAt: "asc" },
    take: 500,
  });
  const expired: string[] = [];
  for (const { id } of due) {
    const done = await deps.prisma.$transaction(async (tx) => {
      const q = await lockQuote(tx, id);
      if (!q || !q.expiresAt || q.expiresAt.getTime() > now.getTime() || !canTransition(q.status, "EXPIRE", "system")) return false;
      await applyTransition(tx, { quote: q, event: "EXPIRE", actor: "system", actorId: null, now, payload: { expiresAt: q.expiresAt.toISOString() } });
      return true;
    });
    if (done) expired.push(id);
  }
  if (expired.length) deps.log.info("expired quotes", { count: expired.length });
  return { expired };
}
