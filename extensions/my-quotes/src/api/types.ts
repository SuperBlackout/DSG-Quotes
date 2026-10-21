// Every type the UI touches comes from the generated contract (packages/shared, from
// docs/openapi.yaml). Only Customer* shapes are re-exported on purpose: cost, margin and internal
// notes live in Staff* shapes and must never be reachable from this extension (CLAUDE.md rules 4, 5).
import type { Schemas } from "shared";

export type Money = Schemas["Money"];
export type QuoteStatus = Schemas["QuoteStatus"];
export type WaitingOn = Schemas["WaitingOn"];
export type Address = Schemas["Address"];
export type JobRef = Schemas["JobRef"];
export type Attachment = Schemas["Attachment"];

export type CustomerQuoteSummary = Schemas["CustomerQuoteSummary"];
export type CustomerQuote = Schemas["CustomerQuote"];
export type CustomerQuoteLine = Schemas["CustomerQuoteLine"];
export type CustomerQuoteVersion = Schemas["CustomerQuoteVersion"];
export type CustomerQuoteActions = Schemas["CustomerQuoteActions"];
export type CustomerMessage = Schemas["CustomerMessage"];

export type CreateQuoteRequest = Schemas["CreateQuoteRequest"];
export type UpdateQuoteRequest = Schemas["UpdateQuoteRequest"];
export type PostMessageRequest = Schemas["PostMessageRequest"];
export type UploadUrlRequest = Schemas["UploadUrlRequest"];
export type UploadUrl = Schemas["UploadUrl"];
export type NotificationPrefs = Schemas["NotificationPrefs"];
export type NotificationChannelPref = Schemas["NotificationChannelPref"];
export type NotificationEvent = Schemas["NotificationEvent"];
export type Watcher = Schemas["Watcher"];
export type CurrencyCode = Schemas["CurrencyCode"];
export type ApiErrorBody = Schemas["Error"];

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ListQuotesParams {
  status?: QuoteStatus;
  jobId?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}

/** Response of POST /c/quotes/{id}/checkout (inline in openapi.yaml, not a named schema). */
export interface CheckoutResult {
  invoiceUrl: string;
  draftOrderId: string;
}
