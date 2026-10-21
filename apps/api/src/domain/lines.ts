import type { Prisma, Quote, QuoteLine, QuoteVersion, Staff } from "@prisma/client";
import type { Tx } from "../context";
import { D, computeTotals, marginPctOf, type Decimal } from "./money";

export const DEFAULT_FLOOR_PCT = 15;

export type LineWithCost = QuoteLine;

/** True when margin < floor%. Division free: q*(100-f) < 100*c. Unknown cost can't be judged -> false. */
export function isBelowFloor(l: Pick<QuoteLine, "quotedPrice" | "cost">, floorPct: Decimal | number): boolean {
  if (l.cost == null) return false;
  const f = D(floorPct);
  return l.quotedPrice.mul(D(100).sub(f)).lt(l.cost.mul(100));
}

export const byPosition = <T extends { position: number }>(a: T, b: T) => a.position - b.position;

export async function customerLines(tx: Tx, quoteId: string): Promise<QuoteLine[]> {
  return tx.quoteLine.findMany({ where: { quoteId, set: "CUSTOMER" }, orderBy: { position: "asc" } });
}

export async function staffLines(tx: Tx, quoteId: string): Promise<QuoteLine[]> {
  return tx.quoteLine.findMany({ where: { quoteId, set: "STAFF" }, orderBy: { position: "asc" } });
}

export async function latestVersion(tx: Tx, quoteId: string): Promise<(QuoteVersion & { lines: QuoteLine[] }) | null> {
  return tx.quoteVersion.findFirst({
    where: { quoteId },
    orderBy: { versionNo: "desc" },
    include: { lines: { orderBy: { position: "asc" } } },
  });
}

/**
 * Lines the customer sees as "current": their own lines until a revision has been sent, then the latest
 * sent version. Staff repricing in the STAFF set never leaks before `send`.
 */
export async function customerVisibleLines(tx: Tx, quote: Pick<Quote, "id" | "currentVersion" | "status">): Promise<QuoteLine[]> {
  if (quote.currentVersion > 0 && quote.status !== "DRAFT") {
    const v = await latestVersion(tx, quote.id);
    if (v) return v.lines;
  }
  return customerLines(tx, quote.id);
}

/** The editor's working set. Non-draft quotes always have a STAFF set (materialised on submit). */
export async function staffWorkingLines(tx: Tx, quote: Pick<Quote, "id" | "status">): Promise<QuoteLine[]> {
  const mine = await staffLines(tx, quote.id);
  if (mine.length > 0 || quote.status !== "DRAFT") return mine;
  return customerLines(tx, quote.id);
}

/** Copy the customer's lines into the staff working set (on submit). Replaces any previous staff set. */
export async function materializeStaffSet(tx: Tx, quoteId: string) {
  await tx.quoteLine.deleteMany({ where: { quoteId, set: "STAFF" } });
  const src = await customerLines(tx, quoteId);
  if (src.length === 0) return;
  await tx.quoteLine.createMany({
    data: src.map((l) => ({
      quoteId,
      set: "STAFF" as const,
      variantId: l.variantId,
      sku: l.sku,
      title: l.title,
      imageUrl: l.imageUrl,
      qty: l.qty,
      listPrice: l.listPrice,
      quotedPrice: l.quotedPrice,
      cost: l.cost,
      lineNote: l.lineNote,
      addedBy: l.addedBy,
      position: l.position,
    })),
  });
}

export interface FloorContext {
  floorPct: Decimal;
}

/** The floor that applies to a quote: its assigned rep's, else the acting staff member's, else the default. */
export function floorFor(rep: Pick<Staff, "priceFloorPct"> | null | undefined, actor?: Pick<Staff, "priceFloorPct"> | null): Decimal {
  return rep?.priceFloorPct ?? actor?.priceFloorPct ?? D(DEFAULT_FLOOR_PCT);
}

/**
 * Recompute denormalised columns used by list endpoints: customer-visible total + line count, and the staff
 * working set's margin and floor flag. Call after any change to lines, versions or assignment.
 */
export async function refreshDerived(tx: Tx, quoteId: string) {
  const quote = await tx.quote.findUniqueOrThrow({ where: { id: quoteId }, include: { assignedRep: true } });
  const visible = await customerVisibleLines(tx, quote);
  let total: Decimal;
  if (quote.currentVersion > 0 && quote.status !== "DRAFT") {
    const v = await latestVersion(tx, quoteId);
    total = v ? v.total : computeTotals(visible).total;
  } else {
    total = computeTotals(visible).total;
  }
  const working = await staffWorkingLines(tx, quote);
  const t = computeTotals(working, quote.workingFreight);
  const floor = floorFor(quote.assignedRep);
  const belowFloor = working.some((l) => isBelowFloor(l, floor) && !l.floorApproved);
  await tx.quote.update({
    where: { id: quoteId },
    data: {
      total,
      lineCount: visible.length,
      marginPct: t.marginPct == null ? null : D(t.marginPct),
      belowFloor,
    },
  });
}

export { marginPctOf };
export type { Prisma };
