// Status presentation + the status -> available actions mapping.
//
// Rule (ISSUE-3): what a customer may DO comes from the API's `actions` flags, never from re-running
// the state machine here. Status is used only for wording and for choosing which of the allowed
// actions is the row's headline action.
import type { CustomerQuote, CustomerQuoteSummary, QuoteStatus } from "../api/types";
import { formatLongDate, formatMoney, formatRelative, formatShortDate, plural, toCents } from "./format";
import { previousVersion } from "./diff";

type BadgeTone = "auto" | "neutral" | "critical";

const BASE_LABEL: Record<QuoteStatus, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  IN_REVIEW: "In review",
  QUOTE_READY: "Quote ready",
  CHANGES_REQUESTED: "Changes requested",
  ACCEPTED: "Accepted",
  ORDERED: "Ordered",
  EXPIRED: "Expired",
  DECLINED: "Declined",
  ARCHIVED: "Archived",
};

/** "Quote ready · v2", "Accepted". Version only shown while a sent revision is the live one. */
export function statusLabel(q: Pick<CustomerQuoteSummary, "status" | "currentVersion">): string {
  const base = BASE_LABEL[q.status];
  if (q.status === "QUOTE_READY" && q.currentVersion) return `${base} · v${q.currentVersion}`;
  return base;
}

/**
 * s-badge in customer accounts only offers tone auto | neutral | critical (no success/warning),
 * so "needs your attention" is `auto` and everything else is `neutral`.
 */
export function statusBadgeTone(status: QuoteStatus): BadgeTone {
  switch (status) {
    case "QUOTE_READY":
    case "ACCEPTED":
      return "auto";
    case "DECLINED":
      return "critical";
    default:
      return "neutral";
  }
}

// ---------------------------------------------------------------------------------------------
// Row actions (screen 3)
// ---------------------------------------------------------------------------------------------

export type RowActionId = "review" | "buy" | "submit" | "delete" | "duplicate" | "view-order" | "view";

export interface RowAction {
  id: RowActionId;
  label: string;
  variant: "primary" | "secondary";
  tone: "auto" | "critical";
  /** navigate = go to a route/URL, api = calls the API (the UI handles confirm + refresh). */
  kind: "navigate" | "api";
}

const A = {
  review: { id: "review", label: "Review quote", variant: "primary", tone: "auto", kind: "navigate" },
  buy: { id: "buy", label: "Buy now", variant: "primary", tone: "auto", kind: "api" },
  submit: { id: "submit", label: "Submit", variant: "primary", tone: "auto", kind: "api" },
  delete: { id: "delete", label: "Delete draft", variant: "secondary", tone: "critical", kind: "api" },
  duplicate: { id: "duplicate", label: "Duplicate", variant: "secondary", tone: "auto", kind: "api" },
  viewOrder: { id: "view-order", label: "View order", variant: "secondary", tone: "auto", kind: "navigate" },
  view: { id: "view", label: "View", variant: "secondary", tone: "auto", kind: "navigate" },
} as const satisfies Record<string, RowAction>;

/**
 * Row actions for the quote list, in display order.
 *   QUOTE_READY        -> Review quote
 *   ACCEPTED (canBuy)  -> Buy now
 *   DRAFT              -> Submit + Delete draft
 *   ORDERED            -> View order
 *   EXPIRED / DECLINED -> Duplicate
 *   anything else      -> View
 */
export function rowActions(q: CustomerQuoteSummary): RowAction[] {
  const out: RowAction[] = [];
  const a = q.actions;

  if (a.canBuy) out.push(A.buy);
  else if (a.canAccept || a.canRequestChanges) out.push(A.review);

  if (a.canSubmit) out.push(A.submit);
  if (a.canDelete) out.push(A.delete);

  if (q.status === "ORDERED" && q.orderId) out.push(A.viewOrder);
  if (q.status === "EXPIRED" || q.status === "DECLINED") out.push(A.duplicate);

  if (out.length === 0) out.push(A.view);
  return out;
}

/** Second line under the quote name in the list: "6 items · Owner: Dana K. · expires Nov 4". */
export function quoteSubline(q: CustomerQuoteSummary): string {
  const parts: string[] = [];
  if (q.lineCount > 0 || q.status !== "DRAFT") parts.push(plural(q.lineCount, "item"));
  if (q.ownerName) parts.push(`Owner: ${q.ownerName}`);
  if (q.assignedRepName) parts.push(`Rep: ${q.assignedRepName}`);
  const date = q.expiresAt ? formatShortDate(q.expiresAt) : "";
  switch (q.status) {
    case "DRAFT":
      parts.push("not submitted");
      break;
    case "SUBMITTED":
      parts.push("sent to sales team");
      break;
    case "IN_REVIEW":
      parts.push("sales is working on it");
      break;
    case "QUOTE_READY":
      if (date) parts.push(`expires ${date}`);
      break;
    case "ACCEPTED":
      if (date) parts.push(q.actions.canBuy ? `good until ${date}` : `expired ${date}`);
      break;
    case "EXPIRED":
      if (date) parts.push(`expired ${date}`);
      break;
    default:
      break;
  }
  return parts.join(" · ");
}

/** "1 new message" / "3 new messages"; undefined when nothing is unread. */
export function unreadLabel(q: Pick<CustomerQuoteSummary, "unreadCount">): string | undefined {
  const n = q.unreadCount;
  return n > 0 ? `${n} new ${n === 1 ? "message" : "messages"}` : undefined;
}

/**
 * Struck-through old total shown beside the current one ("was $3,900.00"). Only when a previous
 * sent version exists and its total actually differs from the current total.
 */
export function previousTotalText(q: Pick<CustomerQuoteSummary, "total" | "previousTotal" | "currencyCode">): string | undefined {
  if (q.previousTotal === null || q.previousTotal === undefined || q.previousTotal === "") return undefined;
  try {
    if (toCents(q.previousTotal) === toCents(q.total)) return undefined;
  } catch {
    return undefined;
  }
  return formatMoney(q.previousTotal, q.currencyCode);
}

// ---------------------------------------------------------------------------------------------
// Status banner (screen 4)
// ---------------------------------------------------------------------------------------------

export type BannerActionId =
  | "accept"
  | "request-changes"
  | "buy"
  | "submit"
  | "withdraw"
  | "reopen"
  | "ask-new-quote"
  | "view-order";

export interface BannerAction {
  id: BannerActionId;
  label: string;
  variant: "primary" | "secondary";
}

export interface StatusBanner {
  tone: "info" | "success" | "warning" | "critical";
  heading: string;
  body: string;
  actions: BannerAction[];
}

function expiryText(q: CustomerQuote): string {
  return q.expiresAt ? formatLongDate(q.expiresAt) : "";
}

/** True when the quote is past its expiry but the API still reports a not-yet-expired status. */
export function isPastExpiry(q: Pick<CustomerQuote, "expiresAt">, now: Date = new Date()): boolean {
  return !!q.expiresAt && new Date(q.expiresAt).getTime() <= now.getTime();
}

export function statusBanner(q: CustomerQuote, now: Date = new Date()): StatusBanner {
  const a = q.actions;
  const rep = q.assignedRepName ?? "Your DSG rep";
  const latest = q.versions.find((v) => v.versionNo === q.currentVersion) ?? q.versions[q.versions.length - 1];
  const prev = latest ? previousVersion(q.versions, latest.versionNo) : undefined;

  switch (q.status) {
    case "QUOTE_READY": {
      const sent = latest ? ` · ${formatRelative(latest.sentAt, now)}` : "";
      const was = prev && toCents(prev.total) !== toCents(q.total) ? ` (was ${formatMoney(prev.total, q.currencyCode)})` : "";
      const held = q.expiresAt ? ` Prices are held until ${expiryText(q)}.` : "";
      const actions: BannerAction[] = [];
      if (a.canRequestChanges) actions.push({ id: "request-changes", label: "Request changes", variant: "secondary" });
      if (a.canAccept) actions.push({ id: "accept", label: "Accept quote", variant: "primary" });
      return {
        tone: "success",
        heading: `${rep} sent ${latest && latest.versionNo > 1 ? `revision v${latest.versionNo}` : "your quote"}${sent}`,
        body: `New total ${formatMoney(q.total, q.currencyCode)}${was}.${held} Accept to buy, or ask for changes.`,
        actions,
      };
    }

    case "ACCEPTED": {
      if (a.canBuy) {
        const actions: BannerAction[] = [{ id: "buy", label: "Buy now", variant: "primary" }];
        if (a.canReopen) actions.unshift({ id: "reopen", label: "I need a change", variant: "secondary" });
        return {
          tone: "success",
          heading: "You accepted this quote",
          body: `Prices are locked${q.expiresAt ? ` until ${expiryText(q)}` : ""}. Buy now to place the order.`,
          actions,
        };
      }
      return {
        tone: "warning",
        heading: "This quote can no longer be purchased",
        body: "It has expired or changed since you accepted it. Ask for a new quote and your rep will refresh the pricing.",
        actions: [{ id: "ask-new-quote", label: "Ask for a new quote", variant: "primary" }],
      };
    }

    case "DRAFT":
      return {
        tone: "info",
        heading: "This quote is a draft",
        body: "Nothing has been sent to the sales team yet. Submit it when you are ready for pricing.",
        actions: a.canSubmit ? [{ id: "submit", label: "Submit to sales", variant: "primary" }] : [],
      };

    case "SUBMITTED":
      return {
        tone: "info",
        heading: "Sent to the sales team",
        body: "A rep will pick it up and send pricing. You can add details in the conversation meanwhile.",
        actions: a.canWithdraw ? [{ id: "withdraw", label: "Withdraw to edit", variant: "secondary" }] : [],
      };

    case "IN_REVIEW":
      return {
        tone: "info",
        heading: `${rep} is working on your quote`,
        body: "You will get an email or text as soon as pricing is ready.",
        actions: [],
      };

    case "CHANGES_REQUESTED":
      return {
        tone: "info",
        heading: "Changes requested",
        body: `Your request went to ${rep}. A revised quote will follow.`,
        actions: [],
      };

    case "ORDERED":
      return {
        tone: "success",
        heading: "Ordered",
        body: q.orderId ? `This quote became order ${q.orderId}.` : "This quote has been turned into an order.",
        actions: q.orderId ? [{ id: "view-order", label: "View order", variant: "secondary" }] : [],
      };

    case "EXPIRED":
      return {
        tone: "warning",
        heading: "This quote has expired",
        body: "Held prices lapsed. Ask for a new quote to get current pricing.",
        actions: [{ id: "ask-new-quote", label: "Ask for a new quote", variant: "primary" }],
      };

    case "DECLINED":
      return {
        tone: "info",
        heading: "This quote was declined",
        body: "It is closed. Duplicate it to start a new one.",
        actions: [],
      };

    case "ARCHIVED":
      return { tone: "info", heading: "This quote was deleted", body: "", actions: [] };
  }
}

/** Messages that mean "purchase failed because of state" (API 409s) and should offer a fresh quote. */
export function isNotPurchasableError(code: string): boolean {
  return code === "NOT_PURCHASABLE";
}
