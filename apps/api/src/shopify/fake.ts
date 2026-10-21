import type {
  BuyerContext,
  CompleteDraftOrderResult,
  DraftOrderInput,
  DraftOrderResult,
  ShopifyGateway,
  VariantPricing,
} from "./types";
import { ShopifyUserError } from "./types";

/** In-memory Shopify for tests and local dev. Records every mutation so tests can assert on it. */
export class FakeShopify implements ShopifyGateway {
  buyers = new Map<string, BuyerContext>();
  /** variantId -> pricing, optionally per company location (`${variantId}@${locationId}`). */
  variants = new Map<string, VariantPricing>();
  createdDraftOrders: { input: DraftOrderInput; result: DraftOrderResult }[] = [];
  completedDraftOrders: string[] = [];
  deletedDraftOrders: string[] = [];
  /** Set to make the next createDraftOrder reject. */
  failNextCreate: Error | null = null;
  private seq = 100;

  addBuyer(b: Partial<BuyerContext> & Pick<BuyerContext, "customerId">): BuyerContext {
    const locationId = b.companyLocationId ?? "gid://shopify/CompanyLocation/1";
    const full: BuyerContext = {
      name: "Dana Dealer",
      email: "dana@example.test",
      companyId: "gid://shopify/Company/1",
      companyName: "Acme Dealers",
      companyContactId: `gid://shopify/CompanyContact/${b.customerId.split("/").pop()}`,
      locations: [{ id: locationId, name: "Main" }],
      companyLocationId: locationId,
      paymentTermsTemplateId: null,
      currencyCode: "USD",
      ...b,
    };
    this.buyers.set(full.customerId, full);
    return full;
  }

  addVariant(v: Partial<VariantPricing> & Pick<VariantPricing, "variantId" | "price">, locationId?: string): VariantPricing {
    const full: VariantPricing = { sku: "SKU-" + v.variantId.split("/").pop(), title: "Widget", imageUrl: null, unitCost: null, ...v };
    this.variants.set(locationId ? `${v.variantId}@${locationId}` : v.variantId, full);
    return full;
  }

  async resolveBuyer(customerId: string, preferredLocationId?: string | null) {
    const b = this.buyers.get(customerId);
    if (!b) return null;
    const loc = preferredLocationId && b.locations.some((l) => l.id === preferredLocationId) ? preferredLocationId : b.companyLocationId;
    return { ...b, companyLocationId: loc };
  }

  async getVariantPricing(buyer: { companyLocationId: string }, variantId: string) {
    return this.variants.get(`${variantId}@${buyer.companyLocationId}`) ?? this.variants.get(variantId) ?? null;
  }

  async createDraftOrder(input: DraftOrderInput): Promise<DraftOrderResult> {
    if (this.failNextCreate) {
      const e = this.failNextCreate;
      this.failNextCreate = null;
      throw e;
    }
    if (input.lines.length === 0) throw new ShopifyUserError("draftOrderCreate: no line items", [{ message: "Line items required" }]);
    const n = ++this.seq;
    const result = { id: `gid://shopify/DraftOrder/${n}`, name: `#D${n}`, invoiceUrl: `https://fake-shop.example.test/invoices/${n}` };
    this.createdDraftOrders.push({ input, result });
    return result;
  }

  async completeDraftOrder(draftOrderId: string): Promise<CompleteDraftOrderResult> {
    this.completedDraftOrders.push(draftOrderId);
    const n = draftOrderId.split("/").pop();
    return { draftOrderId, orderId: `gid://shopify/Order/${n}`, statusUrl: `https://fake-shop.example.test/orders/${n}` };
  }

  async deleteDraftOrder(draftOrderId: string) {
    this.deletedDraftOrders.push(draftOrderId);
  }
}
