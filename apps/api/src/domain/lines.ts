import type { Prisma, Quote, QuoteLine, QuoteVersion, Staff } from "@prisma/client";
import type { Tx } from "../context";
import { D, checkedTotals, clampPct, marginPctOf, type Decimal } from "./money";

export const DEFAULT_FLOOR_PCT = 15;

export type LineWithCost = QuoteLine;

/** Cost could not be read from inventory: margin cannot be judged, so the line always needs manager approval. */
export const isCostUnknown = (l: Pick<QuoteLine, "cost">): boolean => l.cost == null;

/**
 * True when the line needs manager floor approval: margin < floor% (division free: q*(100-f) < 100*c), or the cost is
 * unknown (it can never be margin-checked, contract 0.2.0 `costUnknown`).
 */
export function isBelowFloor(l: Pick<QuoteLine, "quotedPrice" | "cost">, floorPct: Decimal | number): boolean {
  if (l.cost == null) return true;
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

/** The shop-wide default minimum margin (ShopSetting.defaultPriceFloorPct), 15 until a manager changes it. */
export async function defaultFloor(tx: Tx, shop: string): Promise<Decimal> {
  const s = await tx.shopSetting.findUnique({ where: { shop } });
  return s ? D(s.defaultPriceFloorPct) : D(DEFAULT_FLOOR_PCT);
}

/**
 * The floor that applies to a quote: its assigned rep's personal override, else the acting staff member's override,
 * else the shop default (pass it from `defaultFloor`).
 */
export function floorFor(
  rep: Pick<Staff, "priceFloorPct"> | null | undefined,
  actor: Pick<Staff, "priceFloorPct"> | null | undefined,
  shopDefault: Decimal | number = DEFAULT_FLOOR_PCT,
): Decimal {
  return rep?.priceFloorPct ?? actor?.priceFloorPct ?? D(shopDefault);
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
    total = v ? v.total : checkedTotals(visible).total;
  } else {
    total = checkedTotals(visible).total;
  }
  const working = await staffWorkingLines(tx, quote);
  const t = checkedTotals(working, quote.workingFreight);
  const floor = floorFor(quote.assignedRep, null, await defaultFloor(tx, quote.shop));
  const belowFloor = working.some((l) => isBelowFloor(l, floor) && !l.floorApproved);
  await tx.quote.update({
    where: { id: quoteId },
    data: {
      total,
      lineCount: visible.length,
      marginPct: t.marginPct == null ? null : clampPct(D(t.marginPct)),
      belowFloor,
    },
  });
}

export { marginPctOf };
export type { Prisma };
