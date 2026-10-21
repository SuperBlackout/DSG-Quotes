// Typed fixtures built from the contract schemas. Dev-store style fake data only (CLAUDE.md rule 8).
import type {
  CustomerMessage,
  CustomerQuote,
  CustomerQuoteActions,
  CustomerQuoteLine,
  CustomerQuoteSummary,
  CustomerQuoteVersion,
  NotificationPrefs,
  QuoteStatus,
} from "../src/api/types";

export const NO_ACTIONS: CustomerQuoteActions = {
  canEditLines: false,
  canSubmit: false,
  canWithdraw: false,
  canAccept: false,
  canRequestChanges: false,
  canBuy: false,
  canReopen: false,
  canDelete: false,
  canDecline: false,
};

/** Actions as the API would return them per status (server-computed; fixtures only mimic them). */
export const ACTIONS_BY_STATUS: Record<QuoteStatus, CustomerQuoteActions> = {
  DRAFT: { ...NO_ACTIONS, canEditLines: true, canSubmit: true, canDelete: true },
  SUBMITTED: { ...NO_ACTIONS, canWithdraw: true, canDecline: true },
  IN_REVIEW: { ...NO_ACTIONS, canDecline: true },
  QUOTE_READY: { ...NO_ACTIONS, canAccept: true, canRequestChanges: true, canDecline: true },
  CHANGES_REQUESTED: { ...NO_ACTIONS, canDecline: true },
  ACCEPTED: { ...NO_ACTIONS, canBuy: true, canReopen: true },
  ORDERED: NO_ACTIONS,
  EXPIRED: NO_ACTIONS,
  DECLINED: NO_ACTIONS,
  ARCHIVED: NO_ACTIONS,
};

const WAITING = {
  DRAFT: "customer",
  SUBMITTED: "sales",
  IN_REVIEW: "sales",
  QUOTE_READY: "customer",
  CHANGES_REQUESTED: "sales",
  ACCEPTED: "customer",
  ORDERED: "none",
  EXPIRED: "none",
  DECLINED: "none",
  ARCHIVED: "none",
} as const satisfies Record<QuoteStatus, "customer" | "sales" | "none">;

export function summary(over: Partial<CustomerQuoteSummary> & { status: QuoteStatus }): CustomerQuoteSummary {
  return {
    id: "q1",
    number: 10482,
    displayNumber: "Q-10482",
    title: "Exam rooms AV",
    waitingOn: WAITING[over.status],
    job: { id: "job1", name: "Lakeview Clinic", poNumber: "4471", siteAddress: "22 Lake Rd, Ronkonkoma NY" },
    currentVersion: 1,
    lineCount: 6,
    total: "3640.00",
    expiresAt: "2026-11-04T23:59:00.000Z",
    updatedAt: "2026-10-21T10:00:00.000Z",
    actions: ACTIONS_BY_STATUS[over.status],
    ...over,
  };
}

export function line(over: Partial<CustomerQuoteLine> & { variantId: string }): CustomerQuoteLine {
  return {
    id: `l-${over.variantId}`,
    sku: "SKU",
    title: `Item ${over.variantId}`,
    qty: 1,
    listPrice: "100.00",
    quotedPrice: "90.00",
    lineTotal: "90.00",
    position: 0,
    ...over,
  };
}

export function version(over: Partial<CustomerQuoteVersion> & { versionNo: number }): CustomerQuoteVersion {
  return {
    sentAt: "2026-10-18T15:00:00.000Z",
    subtotal: "0.00",
    discountTotal: "0.00",
    freight: "0.00",
    total: "0.00",
    lines: [],
    ...over,
  };
}

export function message(over: Partial<CustomerMessage> & { id: string }): CustomerMessage {
  return {
    authorType: "STAFF",
    authorName: "Marco Reyes",
    body: "Hello",
    attachments: [],
    channel: "WEB",
    createdAt: "2026-10-19T13:12:00.000Z",
    ...over,
  };
}

export function quote(over: Partial<CustomerQuote> & { status: QuoteStatus }): CustomerQuote {
  return {
    ...summary(over),
    lines: [],
    versions: [],
    messages: [],
    ...over,
  };
}

export function prefs(over: Partial<NotificationPrefs> = {}): NotificationPrefs {
  return {
    events: {
      QUOTE_READY: { email: true, sms: true },
      NEW_MESSAGE: { email: true, sms: true },
      QUOTE_RECEIVED: { email: true, sms: false },
      EXPIRING: { email: true, sms: true },
      ORDERED: { email: true, sms: false },
      WEEKLY_SUMMARY: { email: false, sms: false },
      ACCEPTED: { email: true, sms: false },
    },
    email: "dana@example.com",
    phone: "+15165550142",
    smsOptIn: true,
    smsConsentText: "old text",
    smsOptInAt: "2026-10-02T12:00:00.000Z",
    quietStart: "19:00",
    quietEnd: "07:00",
    timezone: "America/New_York",
    watchers: ["sam@example.com"],
    ...over,
  };
}
