import type { Prisma, Staff } from "@prisma/client";
import { canTransition } from "shared";
import type { Schemas } from "shared";
import type { AppDeps, StaffPrincipal, Tx } from "../context";
import { ApiError, notFound } from "../errors";
import { staffQuote } from "../serializers/staff";
import { floorFor, isBelowFloor, latestVersion, refreshDerived, staffWorkingLines } from "./lines";
import { computeTotals, ZERO, parseMoney, fmt, D } from "./money";
import type { VariantPricing } from "../shopify/types";
import { applyTransition, lockQuote, writeEvent } from "./transitions";

export type StaffActor = StaffPrincipal["staff"];

/** Staff see every quote in the shop. */
export async function getStaffQuoteRow(tx: Tx, deps: AppDeps, id: string, lock = false) {
  const q = await tx.quote.findFirst({ where: { id, shop: deps.config.shopDomain } });
  if (!q) throw notFound();
  if (lock) await lockQuote(tx, id);
  return tx.quote.findUniqueOrThrow({ where: { id }, include: { job: true, assignedRep: true } });
}

export async function loadStaffView(tx: Tx, deps: AppDeps, id: string, actor?: Pick<Staff, "priceFloorPct">): Promise<Schemas["StaffQuote"]> {
  const quote = await tx.quote.findUniqueOrThrow({ where: { id }, include: { job: true, assignedRep: true } });
  const [working, versions, messages, events, change] = await Promise.all([
    staffWorkingLines(tx, quote),
    tx.quoteVersion.findMany({ where: { quoteId: id }, orderBy: { versionNo: "asc" }, include: { lines: true } }),
    tx.message.findMany({ where: { quoteId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    tx.event.findMany({ where: { quoteId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    tx.event.findFirst({ where: { quoteId: id, type: "REQUEST_CHANGES" }, orderBy: { createdAt: "desc" } }),
  ]);
  const payload = (change?.payload ?? {}) as { message?: unknown };
  return staffQuote({
    quote,
    working,
    versions,
    messages,
    events,
    floor: floorFor(quote.assignedRep, actor),
    latestChangeRequest: typeof payload.message === "string" ? payload.message : null,
  });
}

export const WORKING_STATUSES = ["SUBMITTED", "IN_REVIEW", "QUOTE_READY", "CHANGES_REQUESTED"] as const;
export const DEFAULT_EXPIRY_MS = (days: number) => days * 24 * 60 * 60 * 1000;

export interface DraftRevisionInput {
  lines: { id?: string; variantId: string; qty: number; quotedPrice: string; lineNote?: string | null }[];
  freight?: string;
  expiresAt?: string | null;
  repNote?: string | null;
  internalNote?: string | null;
}

/** Save the rep's working revision. Never visible to the customer until `send`. */
export async function saveDraftRevision(
  tx: Tx,
  deps: AppDeps,
  quoteId: string,
  input: DraftRevisionInput,
  pricingFor: (variantId: string) => Promise<VariantPricing | null>,
) {
  const quote = await tx.quote.findUniqueOrThrow({ where: { id: quoteId } });
  const existing = await tx.quoteLine.findMany({ where: { quoteId, set: "STAFF" } });
  const byId = new Map(existing.map((l) => [l.id, l]));
  const keep = new Set<string>();
  let position = 0;

  for (const l of input.lines) {
    position += 1;
    const price = parsePrice(l.quotedPrice);
    if (l.id) {
      const cur = byId.get(l.id);
      if (!cur) throw new ApiError("VALIDATION_FAILED", "Unknown working line", { field: "lines", lineId: l.id });
      if (cur.variantId !== l.variantId) throw new ApiError("VALIDATION_FAILED", "A line's product cannot be changed; remove it and add a new one", { lineId: l.id });
      keep.add(cur.id);
      const priceChanged = !cur.quotedPrice.equals(price) || cur.qty !== l.qty;
      await tx.quoteLine.update({
        where: { id: cur.id },
        data: {
          qty: l.qty,
          quotedPrice: price,
          lineNote: l.lineNote ?? null,
          position,
          // A manager approval covers one specific price/qty; any change needs a fresh approval.
          ...(priceChanged ? { floorApproved: false, floorApprovedById: null } : {}),
        },
      });
    } else {
      const p = await pricingFor(l.variantId);
      if (!p) throw new ApiError("VALIDATION_FAILED", "Product variant not found", { field: "variantId", variantId: l.variantId });
      const created = await tx.quoteLine.create({
        data: {
          quoteId,
          set: "STAFF",
          variantId: p.variantId,
          sku: p.sku,
          title: p.title,
          imageUrl: p.imageUrl,
          qty: l.qty,
          listPrice: parseMoney(p.price),
          quotedPrice: price,
          cost: p.unitCost == null ? null : parseMoney(p.unitCost),
          lineNote: l.lineNote ?? null,
          addedBy: "STAFF",
          position,
        },
      });
      keep.add(created.id);
    }
  }
  const drop = existing.filter((l) => !keep.has(l.id)).map((l) => l.id);
  if (drop.length) await tx.quoteLine.deleteMany({ where: { id: { in: drop } } });

  const data: Prisma.QuoteUncheckedUpdateInput = {};
  if (input.freight !== undefined) {
    const f = parsePrice(input.freight);
    data.workingFreight = f;
  }
  if (input.expiresAt !== undefined) data.workingExpiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (input.repNote !== undefined) data.workingRepNote = input.repNote;
  if (input.internalNote !== undefined) data.workingInternalNote = input.internalNote;
  if (Object.keys(data).length) await tx.quote.update({ where: { id: quoteId }, data });
  await writeEvent(tx, quoteId, "DRAFT_SAVED", "staff", null, { lineCount: input.lines.length, version: quote.currentVersion });
  await refreshDerived(tx, quoteId);
}

function parsePrice(v: string) {
  let d;
  try {
    d = parseMoney(v);
  } catch {
    throw new ApiError("VALIDATION_FAILED", `Invalid amount: ${v}`);
  }
  if (d.lt(0)) throw new ApiError("VALIDATION_FAILED", "Amounts cannot be negative");
  return d;
}

export interface SendResult {
  versionNo: number;
}

/**
 * Freeze the working lines into QuoteVersion N+1 and move to QUOTE_READY (all in the caller's transaction,
 * quote already locked). Blocks with 422 FLOOR_APPROVAL_REQUIRED when any line is under the floor without
 * manager approval. Default expiry is now + defaultExpiryDays (14).
 */
export async function sendRevision(tx: Tx, deps: AppDeps, quoteId: string, actor: StaffActor): Promise<SendResult> {
  const now = deps.now();
  const quote = await tx.quote.findUniqueOrThrow({ where: { id: quoteId }, include: { assignedRep: true } });
  if (!canTransition(quote.status, "SEND_REVISION", "staff")) {
    throw new ApiError("INVALID_TRANSITION", `SEND_REVISION is not allowed from ${quote.status}`, { status: quote.status });
  }
  const lines = await tx.quoteLine.findMany({ where: { quoteId, set: "STAFF" }, orderBy: { position: "asc" } });
  if (lines.length === 0) throw new ApiError("VALIDATION_FAILED", "Add at least one line before sending", { field: "lines" });

  // The rep owning the quote decides the floor; an unassigned quote is claimed by whoever sends it.
  const floor = floorFor(quote.assignedRep, actor);
  const blocked = lines.filter((l) => isBelowFloor(l, floor) && !l.floorApproved);
  if (blocked.length) {
    throw new ApiError("FLOOR_APPROVAL_REQUIRED", "Some lines are below the price floor and need manager approval", {
      lineIds: blocked.map((l) => l.id),
      floorPct: floor.toString(),
    });
  }

  const expiresAt = quote.workingExpiresAt ?? new Date(now.getTime() + DEFAULT_EXPIRY_MS(deps.config.defaultExpiryDays));
  if (expiresAt.getTime() <= now.getTime()) throw new ApiError("VALIDATION_FAILED", "Expiry must be in the future", { field: "expiresAt" });

  const totals = computeTotals(lines, quote.workingFreight);
  const versionNo = quote.currentVersion + 1;
  const version = await tx.quoteVersion.create({
    data: {
      quoteId,
      versionNo,
      sentById: actor.id,
      sentAt: now,
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      freight: quote.workingFreight,
      total: totals.total,
      repNote: quote.workingRepNote,
      internalNote: quote.workingInternalNote,
    },
  });
  await tx.quoteLine.createMany({
    data: lines.map((l) => ({
      quoteId,
      set: "VERSION" as const,
      versionId: version.id,
      variantId: l.variantId,
      sku: l.sku,
      title: l.title,
      imageUrl: l.imageUrl,
      qty: l.qty,
      listPrice: l.listPrice,
      quotedPrice: l.quotedPrice,
      cost: l.cost,
      lineNote: l.lineNote,
      floorApproved: l.floorApproved,
      floorApprovedById: l.floorApprovedById,
      addedBy: l.addedBy,
      position: l.position,
    })),
  });
  await applyTransition(tx, {
    quote,
    event: "SEND_REVISION",
    actor: "staff",
    actorId: actor.id,
    now,
    data: {
      currentVersion: versionNo,
      expiresAt,
      workingExpiresAt: null, // the next revision defaults to a fresh +14 days unless the rep picks a date
      ...(quote.assignedRepId ? {} : { assignedRep: { connect: { id: actor.id } } }),
    },
    payload: { versionNo, total: fmt(totals.total), expiresAt: expiresAt.toISOString() },
  });
  await refreshDerived(tx, quoteId);
  return { versionNo };
}

export { latestVersion, ZERO, D };
