/**
 * Everything the API needs from Shopify, behind one interface. Routes and domain code only ever see
 * `ShopifyGateway`; `real.ts` talks to the Admin GraphQL API, `fake.ts` is used in tests and local dev.
 * Money is a 2-place decimal string (same as the API contract).
 */

export interface CompanyLocationRef {
  id: string; // gid://shopify/CompanyLocation/...
  name: string;
}

export interface BuyerContext {
  customerId: string; // gid://shopify/Customer/...
  name: string;
  email: string | null;
  companyId: string; // gid://shopify/Company/...
  companyName: string;
  /** gid://shopify/CompanyContact/... needed for draft order purchasingEntity. */
  companyContactId: string;
  /** All locations this contact may buy for. */
  locations: CompanyLocationRef[];
  /** The selected location. Every /c query is scoped to it. */
  companyLocationId: string;
  /** Set when the location has net terms: checkout completes the draft order instead of returning an invoice. */
  paymentTermsTemplateId: string | null;
  /** Human name of those terms ("Net 30"), shown read-only to staff. */
  paymentTerms?: string | null;
  /** The contact's phone, when Shopify has one (shown to staff only). */
  phone?: string | null;
  currencyCode: string;
}

/** One match from the staff customer search (GET /s/customers). */
export interface CustomerSearchResult {
  customerId: string;
  name: string;
  email: string;
  phone: string | null;
  companyId: string | null;
  companyName: string | null;
  locations: { companyLocationId: string; name: string; shipTo: Record<string, string | null> | null }[];
}

export interface VariantPricing {
  variantId: string;
  sku: string | null;
  title: string; // "Product title - Variant title"
  imageUrl: string | null;
  /** Buyer-contextual unit price (company location catalog). */
  price: string;
  /** Inventory item unit cost, or null when not set. STAFF ONLY. */
  unitCost: string | null;
}

export interface DraftOrderLineInput {
  variantId: string;
  quantity: number;
  /** Locked price from the quote (quotedPrice). */
  priceOverride: string;
}

export interface DraftOrderInput {
  /** Human quote number, e.g. "Q-10482"; also sent as tag `quote:Q-10482`. */
  quoteLabel: string;
  currencyCode: string;
  customerId: string;
  companyId: string;
  companyContactId: string;
  companyLocationId: string;
  lines: DraftOrderLineInput[];
  /** Freight as a shipping line; omit when zero. */
  freight: string | null;
  poNumber: string | null;
  note: string | null;
  tags: string[];
  paymentTermsTemplateId: string | null;
}

export interface DraftOrderResult {
  id: string; // gid://shopify/DraftOrder/...
  name: string; // "#D12"
  invoiceUrl: string;
}

export interface CompleteDraftOrderResult {
  draftOrderId: string;
  orderId: string | null;
  /** Customer-facing order status page when available. */
  statusUrl: string | null;
}

export interface ShopifyGateway {
  /** Resolve the logged-in customer to a company buyer. Null when the customer is not a B2B contact. */
  resolveBuyer(customerId: string, preferredLocationId?: string | null): Promise<BuyerContext | null>;
  getVariantPricing(buyer: Pick<BuyerContext, "companyLocationId" | "customerId">, variantId: string): Promise<VariantPricing | null>;
  createDraftOrder(input: DraftOrderInput): Promise<DraftOrderResult>;
  completeDraftOrder(draftOrderId: string, opts: { paymentPending: boolean }): Promise<CompleteDraftOrderResult>;
  /** Find company contacts by name, email, phone or company name (staff "create quote on behalf"). */
  searchCustomers(query: string, limit: number): Promise<CustomerSearchResult[]>;
  /** Best effort; must not throw if the draft order is already gone. */
  deleteDraftOrder(draftOrderId: string): Promise<void>;
}

export class ShopifyUserError extends Error {
  override name = "ShopifyUserError";
  constructor(
    message: string,
    readonly userErrors: { field?: string[] | null; message: string }[] = [],
  ) {
    super(message);
  }
}
