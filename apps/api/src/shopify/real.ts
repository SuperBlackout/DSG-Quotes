import { ADMIN_GRAPHQL_PATH } from "shared";
import {
  BUYER_BY_CUSTOMER,
  DRAFT_ORDER_COMPLETE,
  DRAFT_ORDER_CREATE,
  DRAFT_ORDER_DELETE,
  VARIANT_PRICING,
} from "./graphql";
import type {
  BuyerContext,
  CompleteDraftOrderResult,
  DraftOrderInput,
  DraftOrderResult,
  ShopifyGateway,
  VariantPricing,
} from "./types";
import { ShopifyUserError } from "./types";

export interface RealShopifyOptions {
  shopDomain: string;
  /** Offline Admin API access token (from the Session table). */
  getAccessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

type UserErrors = { field?: string[] | null; message: string }[] | undefined;

/**
 * Admin GraphQL implementation. UNVERIFIED against a live shop: field names follow the public docs for
 * ADMIN_API_VERSION and must be checked with `pnpm -F api graphql:validate` plus a dev-store run.
 */
export class RealShopify implements ShopifyGateway {
  private readonly f: typeof fetch;
  constructor(private readonly opts: RealShopifyOptions) {
    this.f = opts.fetchImpl ?? fetch;
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const token = await this.opts.getAccessToken();
    const res = await this.f(`https://${this.opts.shopDomain}${ADMIN_GRAPHQL_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-access-token": token },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`Shopify Admin API HTTP ${res.status}`);
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (json.errors?.length) throw new Error(`Shopify GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
    if (!json.data) throw new Error("Shopify GraphQL returned no data");
    return json.data;
  }

  private static check(errors: UserErrors, what: string) {
    if (errors && errors.length) throw new ShopifyUserError(`${what}: ${errors.map((e) => e.message).join("; ")}`, errors);
  }

  async resolveBuyer(customerId: string, preferredLocationId?: string | null): Promise<BuyerContext | null> {
    type R = {
      shop: { currencyCode: string };
      customer: {
        id: string;
        displayName: string;
        defaultEmailAddress: { emailAddress: string } | null;
        companyContactProfiles: {
          id: string;
          company: { id: string; name: string };
          roleAssignments: {
            nodes: {
              companyLocation: {
                id: string;
                name: string;
                buyerExperienceConfiguration: { paymentTermsTemplate: { id: string } | null } | null;
              };
            }[];
          };
        }[];
      } | null;
    };
    const data = await this.gql<R>(BUYER_BY_CUSTOMER, { id: customerId });
    const c = data.customer;
    const profile = c?.companyContactProfiles[0];
    if (!c || !profile) return null;
    const locs = profile.roleAssignments.nodes.map((n) => n.companyLocation);
    if (locs.length === 0) return null;
    const chosen = locs.find((l) => l.id === preferredLocationId) ?? locs[0]!;
    return {
      customerId: c.id,
      name: c.displayName,
      email: c.defaultEmailAddress?.emailAddress ?? null,
      companyId: profile.company.id,
      companyName: profile.company.name,
      companyContactId: profile.id,
      locations: locs.map((l) => ({ id: l.id, name: l.name })),
      companyLocationId: chosen.id,
      paymentTermsTemplateId: chosen.buyerExperienceConfiguration?.paymentTermsTemplate?.id ?? null,
      currencyCode: data.shop.currencyCode,
    };
  }

  async getVariantPricing(buyer: { companyLocationId: string }, variantId: string): Promise<VariantPricing | null> {
    type R = {
      productVariant: {
        id: string;
        sku: string | null;
        displayName: string;
        image: { url: string } | null;
        product: { featuredMedia: { preview: { image: { url: string } | null } | null } | null };
        contextualPricing: { price: { amount: string } };
        inventoryItem: { unitCost: { amount: string } | null } | null;
      } | null;
    };
    const data = await this.gql<R>(VARIANT_PRICING, { id: variantId, companyLocationId: buyer.companyLocationId });
    const v = data.productVariant;
    if (!v) return null;
    const money = (a: string) => Number(a).toFixed(2);
    return {
      variantId: v.id,
      sku: v.sku,
      title: v.displayName,
      imageUrl: v.image?.url ?? v.product.featuredMedia?.preview?.image?.url ?? null,
      price: money(v.contextualPricing.price.amount),
      unitCost: v.inventoryItem?.unitCost ? money(v.inventoryItem.unitCost.amount) : null,
    };
  }

  async createDraftOrder(input: DraftOrderInput): Promise<DraftOrderResult> {
    const gqlInput: Record<string, unknown> = {
      purchasingEntity: {
        purchasingCompany: {
          companyId: input.companyId,
          companyContactId: input.companyContactId,
          companyLocationId: input.companyLocationId,
        },
      },
      lineItems: input.lines.map((l) => ({
        variantId: l.variantId,
        quantity: l.quantity,
        priceOverride: { amount: l.priceOverride, currencyCode: input.currencyCode },
      })),
      tags: input.tags,
      note: input.note ?? undefined,
      poNumber: input.poNumber ?? undefined,
    };
    if (input.freight) {
      gqlInput.shippingLine = { title: "Freight", price: input.freight };
    }
    if (input.paymentTermsTemplateId) {
      gqlInput.paymentTerms = { paymentTermsTemplateId: input.paymentTermsTemplateId };
    }
    type R = { draftOrderCreate: { draftOrder: { id: string; name: string; invoiceUrl: string } | null; userErrors: UserErrors } };
    const data = await this.gql<R>(DRAFT_ORDER_CREATE, { input: gqlInput });
    RealShopify.check(data.draftOrderCreate.userErrors, "draftOrderCreate");
    const d = data.draftOrderCreate.draftOrder;
    if (!d) throw new ShopifyUserError("draftOrderCreate returned no draft order");
    return { id: d.id, name: d.name, invoiceUrl: d.invoiceUrl };
  }

  async completeDraftOrder(draftOrderId: string, opts: { paymentPending: boolean }): Promise<CompleteDraftOrderResult> {
    type R = {
      draftOrderComplete: { draftOrder: { id: string; order: { id: string; statusPageUrl: string } | null } | null; userErrors: UserErrors };
    };
    const data = await this.gql<R>(DRAFT_ORDER_COMPLETE, { id: draftOrderId, paymentPending: opts.paymentPending });
    RealShopify.check(data.draftOrderComplete.userErrors, "draftOrderComplete");
    const o = data.draftOrderComplete.draftOrder?.order;
    return { draftOrderId, orderId: o?.id ?? null, statusUrl: o?.statusPageUrl ?? null };
  }

  async deleteDraftOrder(draftOrderId: string): Promise<void> {
    type R = { draftOrderDelete: { deletedId: string | null; userErrors: UserErrors } };
    try {
      await this.gql<R>(DRAFT_ORDER_DELETE, { input: { id: draftOrderId } });
    } catch {
      // best effort: the draft order may already be completed or deleted
    }
  }
}
