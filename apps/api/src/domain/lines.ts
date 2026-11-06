import type { Prisma, Quote, QuoteLine, QuoteVersion, Staff } from "@prisma/client";
import type { Tx } from "../context";
import { ApiError } from "../errors";
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

/** DRAFT and SHARED are the statuses where the CUSTOMER line set is the live, editable one. */
export const isCollaborative = (status: string): boolean => status === "DRAFT" || status === "SHARED";

/**
 * "Shared mode": a rep-created DRAFT or a SHARED quote. The CUSTOMER set holds the shared structure (which items, qty,
 * order); the STAFF set mirrors it row-for-row (`originLineId`) and additionally holds the rep's private pricing.
 */
export const isSharedMode = (q: { status: string; createdByStaffId: string | null }): boolean =>
  q.status === "SHARED" || (q.status === "DRAFT" && q.createdByStaffId != null);

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
  if (quote.currentVersion > 0 && !isCollaborative(quote.status)) {
    const v = await latestVersion(tx, quote.id);
    if (v) return v.lines;
  }
  return customerLines(tx, quote.id);
}

/** The editor's working set. Non-draft quotes always have a STAFF set (materialised on submit). */
export async function staffWorkingLines(tx: Tx, quote: Pick<Quote, "id" | "status">): Promise<QuoteLine[]> {
  const mine = await staffLines(tx, quote.id);
  if (mine.length > 0 || !isCollaborative(quote.status)) return mine;
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
      originLineId: l.id,
    })),
  });
}

/**
 * Make the STAFF (pricing) set mirror the CUSTOMER (shared) set after a structural change: same items, qty, notes and
 * order. Staff price and cost on rows that already exist are kept; a new shared line gets a staff row at the shared
 * price; a deleted shared line loses its staff row. No-op until a staff set exists.
 */
export async function reconcileStaffSet(tx: Tx, quoteId: string) {
  const staff = await staffLines(tx, quoteId);
  if (staff.length === 0) {
    // Nothing priced yet: only seed when the shared set has lines, so the editor has rows to price.
    if ((await customerLines(tx, quoteId)).length > 0) await materializeStaffSet(tx, quoteId);
    return;
  }
  const shared = await customerLines(tx, quoteId);
  const byOrigin = new Map(staff.filter((r) => r.originLineId).map((r) => [r.originLineId!, r]));
  const keep = new Set<string>();
  for (const c of shared) {
    const row = byOrigin.get(c.id);
    if (row) {
      keep.add(row.id);
      await tx.quoteLine.update({ where: { id: row.id }, data: { qty: c.qty, lineNote: c.lineNote, position: c.position } });
    } else {
      const created = await tx.quoteLine.create({
        data: {
          quoteId, set: "STAFF", variantId: c.variantId, sku: c.sku, title: c.title, imageUrl: c.imageUrl, qty: c.qty,
          listPrice: c.listPrice, quotedPrice: c.quotedPrice, cost: c.cost, lineNote: c.lineNote, addedBy: c.addedBy,
          position: c.position, originLineId: c.id,
        },
      });
      keep.add(created.id);
    }
  }
  const drop = staff.filter((r) => !keep.has(r.id)).map((r) => r.id);
  if (drop.length) await tx.quoteLine.deleteMany({ where: { id: { in: drop } } });
}

/** Bump the optimistic-concurrency counter and clear "customer is ready" (any edit invalidates it). */
export async function bumpRev(tx: Tx, quoteId: string) {
  await tx.quote.update({ where: { id: quoteId }, data: { rev: { increment: 1 }, customerReady: false } });
}

/** Renumber CUSTOMER-set positions 1..n to follow `orderedIds`. */
export async function applyLineOrder(tx: Tx, quoteId: string, orderedIds: string[]) {
  for (let i = 0; i < orderedIds.length; i++) {
    await tx.quoteLine.update({ where: { id: orderedIds[i]! }, data: { position: i + 1 } });
  }
}

/** Move a CUSTOMER-set line to sit below `afterLineId` (null = top, undefined = leave at the end). */
export async function placeLineAfter(tx: Tx, quoteId: string, lineId: string, afterLineId: string | null | undefined) {
  if (afterLineId === undefined) return;
  const all = await customerLines(tx, quoteId);
  const ids = all.map((l) => l.id).filter((id) => id !== lineId);
  let at = 0;
  if (afterLineId !== null) {
    const idx = ids.indexOf(afterLineId);
    if (idx < 0) throw new ApiError("VALIDATION_FAILED", "afterLineId is not a line on this quote", { field: "afterLineId" });
    at = idx + 1;
  }
  ids.splice(at, 0, lineId);
  await applyLineOrder(tx, quoteId, ids);
}

/** Validate a full reorder request against the current CUSTOMER set and apply it. */
export async function reorderLines(tx: Tx, quoteId: string, lineIds: string[]) {
  const cur = await customerLines(tx, quoteId);
  const same = lineIds.length === cur.length && new Set(lineIds).size === lineIds.length && cur.every((l) => lineIds.includes(l.id));
  if (!same) throw new ApiError("VALIDATION_FAILED", "lineIds must list every line exactly once", { field: "lineIds" });
  await applyLineOrder(tx, quoteId, lineIds);
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
  if (quote.currentVersion > 0 && !isCollaborative(quote.status)) {
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
