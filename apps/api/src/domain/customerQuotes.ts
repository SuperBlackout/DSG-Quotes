import type { Job, Prisma, Quote } from "@prisma/client";
import type { Schemas } from "shared";
import type { AppDeps, Tx } from "../context";
import { ApiError, notFound } from "../errors";
import { customerQuote } from "../serializers/customer";
import type { BuyerContext, VariantPricing } from "../shopify/types";
import { customerVisibleLines, customerLines, refreshDerived } from "./lines";
import { D, parseMoney } from "./money";
import { lockQuote, writeEvent } from "./transitions";

export const MESSAGE_PAGE = 50;

/** Next quote number for a shop (first is 10001). Atomic: single upsert statement. */
export async function nextQuoteNumber(tx: Tx, shop: string): Promise<number> {
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO "Counter" ("shop", "key", "value") VALUES (${shop}, 'quote', 10001)
    ON CONFLICT ("shop", "key") DO UPDATE SET "value" = "Counter"."value" + 1
    RETURNING "value"`;
  return rows[0]!.value;
}

/** Company-location scope applied to EVERY customer query (CLAUDE.md rule 3). */
export const scopeWhere = (deps: AppDeps, buyer: BuyerContext): Prisma.QuoteWhereInput => ({
  shop: deps.config.shopDomain,
  companyLocationId: buyer.companyLocationId,
  deletedAt: null,
});

/** Load a quote inside the caller's company location, optionally row-locked. Cross-company -> 404. */
export async function getScopedQuote(tx: Tx, deps: AppDeps, buyer: BuyerContext, id: string, lock = false): Promise<Quote> {
  const q = await tx.quote.findFirst({ where: { id, ...scopeWhere(deps, buyer) } });
  if (!q) throw notFound();
  if (!lock) return q;
  const locked = await lockQuote(tx, id);
  if (!locked || locked.deletedAt) throw notFound();
  return locked;
}

export async function loadCustomerView(tx: Tx, deps: AppDeps, id: string): Promise<Schemas["CustomerQuote"]> {
  const quote = await tx.quote.findUniqueOrThrow({ where: { id }, include: { job: true, assignedRep: true } });
  const lines = await customerVisibleLines(tx, quote);
  const versions = await tx.quoteVersion.findMany({
    where: { quoteId: id },
    orderBy: { versionNo: "asc" },
    include: { lines: true },
  });
  const recent = await tx.message.findMany({
    where: { quoteId: id, internal: false },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MESSAGE_PAGE,
  });
  return customerQuote({ quote, rep: quote.assignedRep, lines, versions, messages: recent.reverse() }, deps.now());
}

export async function resolveJob(
  tx: Tx,
  deps: AppDeps,
  buyer: BuyerContext,
  input: { jobId?: string | null; newJob?: { name: string; poNumber?: string; siteAddress?: string } },
): Promise<Job | null> {
  if (input.newJob) {
    return tx.job.create({
      data: {
        shop: deps.config.shopDomain,
        companyId: buyer.companyId,
        companyLocationId: buyer.companyLocationId,
        name: input.newJob.name,
        poNumber: input.newJob.poNumber ?? null,
        siteAddress: input.newJob.siteAddress ?? null,
        createdById: buyer.customerId,
      },
    });
  }
  if (input.jobId) {
    const job = await tx.job.findFirst({
      where: {
        id: input.jobId,
        shop: deps.config.shopDomain,
        archived: false,
        OR: [{ companyLocationId: buyer.companyLocationId }, { companyLocationId: null, companyId: buyer.companyId }],
      },
    });
    if (!job) throw new ApiError("VALIDATION_FAILED", "Job not found", { field: "jobId" });
    return job;
  }
  return null;
}

/** Fetch buyer-contextual pricing for several variants BEFORE opening a transaction. */
export async function fetchPricing(
  deps: AppDeps,
  buyer: BuyerContext,
  variantIds: string[],
): Promise<Map<string, VariantPricing>> {
  const out = new Map<string, VariantPricing>();
  for (const id of new Set(variantIds)) {
    const p = await deps.shopify.getVariantPricing(buyer, id);
    if (!p) throw new ApiError("VALIDATION_FAILED", "Product variant not found", { field: "variantId", variantId: id });
    out.set(id, p);
  }
  return out;
}

/**
 * Add (or merge into) a customer-set line. Price is SNAPSHOTTED here (listPrice = quotedPrice = buyer's
 * contextual price, cost = inventory unit cost) and never follows later catalog changes (rule 6).
 */
export async function addLine(
  tx: Tx,
  quoteId: string,
  pricing: VariantPricing,
  qty: number,
  opts: { lineNote?: string | null; addedBy: "CUSTOMER" | "STAFF" },
) {
  const existing = await tx.quoteLine.findFirst({ where: { quoteId, set: "CUSTOMER", variantId: pricing.variantId } });
  if (existing) {
    await tx.quoteLine.update({
      where: { id: existing.id },
      data: { qty: Math.min(existing.qty + qty, 100000), ...(opts.lineNote ? { lineNote: opts.lineNote } : {}) },
    });
    return;
  }
  const last = await tx.quoteLine.findFirst({ where: { quoteId, set: "CUSTOMER" }, orderBy: { position: "desc" } });
  const price = parseMoney(pricing.price);
  await tx.quoteLine.create({
    data: {
      quoteId,
      set: "CUSTOMER",
      variantId: pricing.variantId,
      sku: pricing.sku,
      title: pricing.title,
      imageUrl: pricing.imageUrl,
      qty,
      listPrice: price,
      quotedPrice: price,
      cost: pricing.unitCost == null ? null : parseMoney(pricing.unitCost),
      lineNote: opts.lineNote ?? null,
      addedBy: opts.addedBy,
      position: (last?.position ?? 0) + 1,
    },
  });
}

export async function createDraft(
  tx: Tx,
  deps: AppDeps,
  buyer: BuyerContext,
  input: {
    title: string;
    job: Job | null;
    poNumber?: string | null;
    neededBy?: string | null;
    notesToSales?: string | null;
    createdByStaffId?: string | null;
    actor: "customer" | "staff";
    actorId: string | null;
  },
): Promise<Quote> {
  const number = await nextQuoteNumber(tx, deps.config.shopDomain);
  const quote = await tx.quote.create({
    data: {
      shop: deps.config.shopDomain,
      number,
      title: input.title,
      jobId: input.job?.id ?? null,
      customerId: buyer.customerId,
      customerName: buyer.name,
      customerEmail: buyer.email,
      companyId: buyer.companyId,
      companyName: buyer.companyName,
      companyLocationId: buyer.companyLocationId,
      poNumber: input.poNumber ?? null,
      neededBy: input.neededBy ? new Date(input.neededBy) : null,
      notesToSales: input.notesToSales ?? null,
      createdByStaffId: input.createdByStaffId ?? null,
    },
  });
  await writeEvent(tx, quote.id, "CREATE", input.actor, input.actorId, { number }, deps.now());
  return quote;
}

export async function setActiveQuote(tx: Tx, deps: AppDeps, buyer: BuyerContext, quoteId: string) {
  const shop = deps.config.shopDomain;
  await tx.activeQuote.upsert({
    where: { shop_customerId: { shop, customerId: buyer.customerId } },
    create: { shop, customerId: buyer.customerId, quoteId },
    update: { quoteId },
  });
}

export { customerLines, refreshDerived, D };
