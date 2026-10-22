import { z } from 'zod';

/** Money is always a decimal string with 2 places, never a float. */
export const Money = z.string().regex(/^-?\d+\.\d{2}$/);
export type Money = z.infer<typeof Money>;

export const DocKind = z.enum(['invoice', 'payment', 'credit_note', 'sales_order']);
export type DocKind = z.infer<typeof DocKind>;

export const StatementSummary = z.object({
  customerName: z.string(),
  customerNumber: z.string(),
  currency: z.string(),
  paymentTerms: z.string().nullable(),
  creditLimit: Money.nullable(),
  outstanding: Money,
  overdue: Money,
  unusedCredits: Money,
  asOf: z.string(),
  stale: z.boolean(),
});
export type StatementSummary = z.infer<typeof StatementSummary>;

export const ActivityItem = z.object({
  id: z.string(),
  kind: DocKind,
  number: z.string(),
  date: z.string(),
  dueDate: z.string().nullable(),
  status: z.string(),
  total: Money,
  balance: Money,
  reference: z.string().nullable(),
  source: z.enum(['zoho', 'shopify']),
  hasPdf: z.boolean(),
});
export type ActivityItem = z.infer<typeof ActivityItem>;

export const ActivityPage = z.object({
  items: z.array(ActivityItem),
  nextCursor: z.string().nullable(),
});
export type ActivityPage = z.infer<typeof ActivityPage>;

export const PdfLink = z.object({ url: z.string(), expiresAt: z.string() });
export type PdfLink = z.infer<typeof PdfLink>;

/** Account info page: Shopify company profile (locations, contacts) joined with the cached Zoho contact. */
export const AccountAddress = z.object({
  address1: z.string().nullable(),
  address2: z.string().nullable(),
  city: z.string().nullable(),
  province: z.string().nullable(),
  zip: z.string().nullable(),
  country: z.string().nullable(),
  phone: z.string().nullable(),
});
export type AccountAddress = z.infer<typeof AccountAddress>;

export const AccountLocation = z.object({
  id: z.string(),
  name: z.string(),
  billingAddress: AccountAddress.nullable(),
  shippingAddress: AccountAddress.nullable(),
});
export type AccountLocation = z.infer<typeof AccountLocation>;

export const AccountContact = z.object({
  name: z.string(),
  email: z.string().nullable(),
  title: z.string().nullable(),
  isMainContact: z.boolean(),
  roles: z.array(z.string()),
});
export type AccountContact = z.infer<typeof AccountContact>;

export const AccountInfo = z.object({
  companyName: z.string(),
  customerNumber: z.string(),
  /** From the cached Zoho contact; null until the first sync has run. */
  currency: z.string().nullable(),
  paymentTerms: z.string().nullable(),
  creditLimit: Money.nullable(),
  /** When the Zoho figures were last refreshed (null: never synced). */
  zohoAsOf: z.string().nullable(),
  locations: z.array(AccountLocation),
  contacts: z.array(AccountContact),
});
export type AccountInfo = z.infer<typeof AccountInfo>;

/** Normalised Zoho shapes used between packages/zoho, worker and DB. */
export const ZohoContact = z.object({
  contact_id: z.string(),
  contact_name: z.string(),
  customer_number: z.string().optional().default(''),
  currency_code: z.string().default('USD'),
  payment_terms_label: z.string().nullable().optional(),
  credit_limit: z.number().nullable().optional(),
  outstanding_receivable_amount: z.number().default(0),
  unused_credits_receivable_amount: z.number().default(0),
});
export type ZohoContact = z.infer<typeof ZohoContact>;

export const ZohoInvoice = z.object({
  invoice_id: z.string(), customer_id: z.string(), invoice_number: z.string(),
  date: z.string(), due_date: z.string().optional(), status: z.string(),
  total: z.number(), balance: z.number(), currency_code: z.string().default('USD'),
  reference_number: z.string().optional().default(''),
});
export const ZohoPayment = z.object({
  payment_id: z.string(), customer_id: z.string(), payment_number: z.string(),
  date: z.string(), amount: z.number(), unused_amount: z.number().default(0),
  currency_code: z.string().default('USD'), reference_number: z.string().optional().default(''),
});
export const ZohoCreditNote = z.object({
  creditnote_id: z.string(), customer_id: z.string(), creditnote_number: z.string(),
  date: z.string(), status: z.string(), total: z.number(), balance: z.number(),
  currency_code: z.string().default('USD'), reference_number: z.string().optional().default(''),
});
export const ZohoSalesOrder = z.object({
  salesorder_id: z.string(), customer_id: z.string(), salesorder_number: z.string(),
  date: z.string(), status: z.string(), total: z.number(),
  currency_code: z.string().default('USD'), reference_number: z.string().optional().default(''),
});
export type ZohoInvoice = z.infer<typeof ZohoInvoice>;
export type ZohoPayment = z.infer<typeof ZohoPayment>;
export type ZohoCreditNote = z.infer<typeof ZohoCreditNote>;
export type ZohoSalesOrder = z.infer<typeof ZohoSalesOrder>;

/** Interface every Zoho client (real or fake) implements. READ-ONLY by design. */
export interface ZohoReader {
  getContact(id: string): Promise<ZohoContact>;
  findContactByCustomerNumber(n: string): Promise<ZohoContact | null>;
  listInvoices(customerId: string, since?: string): Promise<ZohoInvoice[]>;
  listPayments(customerId: string, since?: string): Promise<ZohoPayment[]>;
  listCreditNotes(customerId: string, since?: string): Promise<ZohoCreditNote[]>;
  listSalesOrders(customerId: string, since?: string): Promise<ZohoSalesOrder[]>;
  getInvoicePdf(invoiceId: string): Promise<Uint8Array>;
  getStatementPdf(customerId: string, from: string, to: string): Promise<Uint8Array>;
}

/** Resolved identity of a buyer, derived only from a verified Shopify session token. */
export interface Buyer {
  shopifyCustomerId: string;
  shopifyCompanyId: string;
  role: string;
  zohoCustomerId: string;
  customerNumber: string;
}
export interface BuyerResolver { resolve(authorizationHeader: string | undefined): Promise<Buyer>; }

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const toMoney = (n: number): Money => (Math.round(n * 100) / 100).toFixed(2);
