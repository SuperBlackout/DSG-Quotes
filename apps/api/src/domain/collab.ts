import type { AuthorType, Quote } from "@prisma/client";
import type { AppDeps, Tx } from "../context";
import { ApiError, notFound } from "../errors";
import { bumpRev, customerLines, isSharedMode, reconcileStaffSet } from "./lines";
import { writeEvent } from "./transitions";

/**
 * Shared-review helpers (rep-created quotes, DRAFT -> SHARED -> QUOTE_READY).
 *
 * The CUSTOMER line set is the shared structure both sides edit; the STAFF set mirrors it and holds private pricing
 * (see `lines.ts#isSharedMode`). Comments are anchored to CUSTOMER-set line ids. `internal` comments are staff only.
 */

type QuoteKeys = Pick<Quote, "id" | "status" | "createdByStaffId" | "rev">;

/** After any structural change to the CUSTOMER set: mirror it into the pricing set and bump `rev`. */
export async function afterSharedEdit(tx: Tx, quote: Pick<Quote, "id" | "status" | "createdByStaffId">) {
  if (!isSharedMode(quote)) return;
  await reconcileStaffSet(tx, quote.id);
  await bumpRev(tx, quote.id);
}

/** Optimistic concurrency for shared-mode edits: 409 VERSION_MISMATCH with the current rev when the caller is stale. */
export function assertRev(quote: Pick<Quote, "rev">, rev: number | undefined) {
  if (rev !== undefined && rev !== quote.rev) {
    throw new ApiError("VERSION_MISMATCH", "This quote was changed by someone else. Reload and try again.", { currentRev: quote.rev });
  }
}

/** Delete a CUSTOMER-set line and re-anchor its comments to the line above (or the top), so none are orphaned. */
export async function deleteSharedLine(tx: Tx, quoteId: string, lineId: string) {
  const all = await customerLines(tx, quoteId);
  const idx = all.findIndex((l) => l.id === lineId);
  if (idx < 0) throw notFound("Line");
  const anchor = idx > 0 ? all[idx - 1]!.id : null;
  await tx.quoteComment.updateMany({ where: { quoteId, afterLineId: lineId }, data: { afterLineId: anchor } });
  await tx.quoteLine.delete({ where: { id: lineId } });
  // Renumber so positions stay 1..n.
  const rest = all.filter((l) => l.id !== lineId);
  for (let i = 0; i < rest.length; i++) await tx.quoteLine.update({ where: { id: rest[i]!.id }, data: { position: i + 1 } });
}

export interface CommentAuthor {
  type: AuthorType;
  id: string | null;
  name: string | null;
}

/** Add a comment. `afterLineId` undefined = after the last line; null = above the first; otherwise must be a CUSTOMER-set line. */
export async function addComment(
  tx: Tx,
  deps: AppDeps,
  quote: QuoteKeys,
  author: CommentAuthor,
  input: { body: string; afterLineId?: string | null; internal: boolean },
) {
  const lines = await customerLines(tx, quote.id);
  let anchor: string | null;
  if (input.afterLineId === undefined) anchor = lines.length ? lines[lines.length - 1]!.id : null;
  else if (input.afterLineId === null) anchor = null;
  else if (lines.some((l) => l.id === input.afterLineId)) anchor = input.afterLineId;
  else throw new ApiError("VALIDATION_FAILED", "afterLineId is not a line on this quote", { field: "afterLineId" });
  const row = await tx.quoteComment.create({
    data: {
      quoteId: quote.id,
      afterLineId: anchor,
      authorType: author.type,
      authorId: author.id,
      authorName: author.name,
      body: input.body,
      internal: input.internal,
    },
  });
  // Internal comments are invisible to the customer, so they must not invalidate "customer is ready".
  if (!input.internal) await bumpRev(tx, quote.id);
  await writeEvent(tx, quote.id, "COMMENT", author.type === "CUSTOMER" ? "customer" : "staff", author.id, { commentId: row.id, internal: input.internal }, deps.now());
  return row;
}
