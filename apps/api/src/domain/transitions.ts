import { Prisma, type AuthorType, type Quote } from "@prisma/client";
import { TransitionError, transition, type Actor, type QuoteEvent, type QuoteStatus } from "shared";
import type { Tx } from "../context";
import { ApiError } from "../errors";

/**
 * The ONLY module allowed to write `Quote.status` (CLAUDE.md rule 1). test/no-direct-status-writes.test.ts
 * fails the build if any other file puts `status` inside a Prisma `data:` object.
 */

export const actorType = (a: Actor): AuthorType => (a === "customer" ? "CUSTOMER" : a === "staff" ? "STAFF" : "SYSTEM");

/** Row-lock a quote for the rest of the transaction and return it fresh. Serialises concurrent transitions. */
export async function lockQuote(tx: Tx, quoteId: string): Promise<Quote | null> {
  await tx.$queryRaw`SELECT "id" FROM "Quote" WHERE "id" = ${quoteId} FOR UPDATE`;
  return tx.quote.findUnique({ where: { id: quoteId } });
}

export async function writeEvent(
  tx: Tx,
  quoteId: string,
  type: string,
  actor: Actor,
  actorId: string | null,
  payload: Record<string, unknown>,
  /** The app clock (deps.now()), so event time and every other timestamp share one clock. */
  at: Date,
) {
  return tx.event.create({
    data: { quoteId, type, actorType: actorType(actor), actorId, payload: payload as Prisma.InputJsonValue, createdAt: at },
  });
}

export interface TransitionInput {
  quote: Pick<Quote, "id" | "status">;
  event: QuoteEvent;
  actor: Actor;
  actorId: string | null;
  payload?: Record<string, unknown>;
  /** Extra non-status columns to update in the same statement. */
  data?: Omit<Prisma.QuoteUpdateInput, "status" | "statusChangedAt">;
  now: Date;
}

/**
 * Run `transition()` from packages/shared, persist the new status and insert exactly one `events` row.
 * Must be called inside `prisma.$transaction` with the quote already locked via `lockQuote`.
 * Throws ApiError(INVALID_TRANSITION) when the state machine refuses.
 */
export async function applyTransition(tx: Tx, input: TransitionInput): Promise<{ from: QuoteStatus; to: QuoteStatus }> {
  const from = input.quote.status as QuoteStatus;
  let to: QuoteStatus;
  try {
    to = transition(from, input.event, input.actor);
  } catch (e) {
    if (e instanceof TransitionError) throw new ApiError("INVALID_TRANSITION", e.message, { status: from, event: input.event });
    throw e;
  }
  await tx.quote.update({
    where: { id: input.quote.id },
    data: { ...(input.data ?? {}), status: to, statusChangedAt: input.now },
  });
  await writeEvent(tx, input.quote.id, input.event, input.actor, input.actorId, { from, to, ...(input.payload ?? {}) }, input.now);
  return { from, to };
}
