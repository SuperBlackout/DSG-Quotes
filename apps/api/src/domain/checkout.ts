import { isPurchasable } from "shared";
import type { AppDeps } from "../context";
import { ApiError } from "../errors";
import type { BuyerContext, DraftOrderInput } from "../shopify/types";
import { ShopifyUserError } from "../shopify/types";
import { getScopedQuote } from "./customerQuotes";
import { latestVersion } from "./lines";
import { fmt } from "./money";
import { applyTransition, writeEvent } from "./transitions";

export interface CheckoutResult {
  invoiceUrl: string;
  draftOrderId: string;
}

/**
 * Accept -> buy (PLAN.md "Accept -> buy"). Server-side rules:
 *  1. isPurchasable(status, expiresAt) is re-checked here under a row lock; the client is never trusted.
 *  2. Idempotent: a second call for the same sent version returns the stored draft order, no new Shopify call.
 *  3. The draft order is only recreated after a reopen (reopen clears `draftOrderId`) or a newer version.
 *  4. Lines are priced from the FROZEN version lines at `quotedPrice` via priceOverride; freight is a shipping line.
 * The whole thing runs in one transaction holding the quote row lock, so concurrent "Buy" clicks serialise.
 */
export async function checkoutQuote(deps: AppDeps, buyer: BuyerContext, quoteId: string): Promise<CheckoutResult> {
  const now = deps.now();
  let expired = false;

  const result = await deps.prisma.$transaction(
    async (tx): Promise<CheckoutResult | null> => {
      const quote = await getScopedQuote(tx, deps, buyer, quoteId, true);

      if (!isPurchasable(quote.status, quote.expiresAt, now)) {
        // Lazily expire a stale ACCEPTED quote so the state reflects reality, then refuse.
        if (quote.status === "ACCEPTED" && quote.expiresAt && quote.expiresAt.getTime() <= now.getTime()) {
          await applyTransition(tx, { quote, event: "EXPIRE", actor: "system", actorId: null, now, payload: { lazy: true } });
          expired = true;
          return null;
        }
        throw new ApiError("NOT_PURCHASABLE", `Quote is ${quote.status} and cannot be purchased`, { status: quote.status });
      }

      if (quote.draftOrderId && quote.draftOrderInvoiceUrl && quote.draftOrderVersion === quote.currentVersion) {
        return { invoiceUrl: quote.draftOrderInvoiceUrl, draftOrderId: quote.draftOrderId };
      }

      const version = await latestVersion(tx, quote.id);
      if (!version || version.versionNo !== quote.currentVersion || version.lines.length === 0) {
        throw new ApiError("NOT_PURCHASABLE", "Quote has no sent version to purchase");
      }

      const label = `Q-${quote.number}`;
      const job = quote.jobId ? await tx.job.findUnique({ where: { id: quote.jobId } }) : null;
      const noteParts = [`Quote ${label} v${version.versionNo}`, job ? `Job: ${job.name}` : null, version.repNote].filter(Boolean);
      const input: DraftOrderInput = {
        quoteLabel: label,
        currencyCode: buyer.currencyCode,
        customerId: buyer.customerId,
        companyId: quote.companyId ?? buyer.companyId,
        companyContactId: buyer.companyContactId,
        companyLocationId: quote.companyLocationId ?? buyer.companyLocationId,
        lines: version.lines
          .slice()
          .sort((a, b) => a.position - b.position)
          .map((l) => ({ variantId: l.variantId, quantity: l.qty, priceOverride: fmt(l.quotedPrice) })),
        freight: version.freight.gt(0) ? fmt(version.freight) : null,
        poNumber: quote.poNumber ?? job?.poNumber ?? null,
        note: noteParts.join("\n"),
        tags: [`quote:${label}`],
        paymentTermsTemplateId: buyer.paymentTermsTemplateId,
      };

      let created;
      try {
        created = await deps.shopify.createDraftOrder(input);
      } catch (e) {
        if (e instanceof ShopifyUserError) throw new ApiError("VALIDATION_FAILED", `Could not create the order: ${e.message}`);
        throw new ApiError("INTERNAL", "Could not create the order. Please try again.");
      }

      let invoiceUrl = created.invoiceUrl;
      if (buyer.paymentTermsTemplateId) {
        // Net-terms location: complete with payment pending instead of collecting card payment.
        try {
          const done = await deps.shopify.completeDraftOrder(created.id, { paymentPending: true });
          invoiceUrl = done.statusUrl ?? invoiceUrl;
        } catch (e) {
          if (e instanceof ShopifyUserError) throw new ApiError("VALIDATION_FAILED", `Could not complete the order: ${e.message}`);
          throw new ApiError("INTERNAL", "Could not complete the order. Please try again.");
        }
      }

      await tx.quote.update({
        where: { id: quote.id },
        data: { draftOrderId: created.id, draftOrderInvoiceUrl: invoiceUrl, draftOrderVersion: version.versionNo },
      });
      await writeEvent(tx, quote.id, "CHECKOUT", "customer", buyer.customerId, {
        draftOrderId: created.id,
        versionNo: version.versionNo,
        netTerms: !!buyer.paymentTermsTemplateId,
      });
      return { invoiceUrl, draftOrderId: created.id };
    },
    { timeout: 30_000, maxWait: 10_000 },
  );

  if (expired || !result) throw new ApiError("NOT_PURCHASABLE", "This quote has expired. Ask your rep for a new quote.", { status: "EXPIRED" });
  return result;
}
