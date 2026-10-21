/**
 * Pure helpers that map between API shapes and the editor's working state, plus display helpers shared by
 * the inbox and editor. No React, no I/O, so everything here is unit tested.
 */
import { canTransition, type QuoteStatus } from "shared";
import type { DraftRevisionRequest, InboxTab, StaffQuote, StaffQuoteLine, StaffSummary } from "./api-client";
import { parseMoney, toMoneyString, type PricedLine } from "./pricing";

/* ----------------------------------------------------------------------------------------- lines */

export interface EditorLine extends PricedLine {
  /** Stable React key: server id for saved lines, `new-<n>` for lines added in this session. */
  key: string;
  /** Server line id, absent for lines not yet saved. */
  id?: string;
  variantId: string;
  sku: string | null;
  title: string;
  imageUrl: string | null;
  lineNote: string;
  addedBy?: "CUSTOMER" | "STAFF" | "SYSTEM";
}

export interface EditorState {
  lines: EditorLine[];
  freightCents: number;
  /** ISO date (yyyy-mm-dd) shown in the date input, or "" for none. */
  expiresOn: string;
  repNote: string;
  internalNote: string;
}

export function toEditorLine(l: StaffQuoteLine): EditorLine {
  return {
    key: l.id,
    id: l.id,
    variantId: l.variantId,
    sku: l.sku ?? null,
    title: l.title,
    imageUrl: l.imageUrl ?? null,
    qty: l.qty,
    listPriceCents: parseMoney(l.listPrice) ?? 0,
    costCents: l.cost === null || l.cost === undefined ? null : parseMoney(l.cost),
    quotedPriceCents: parseMoney(l.quotedPrice) ?? 0,
    lineNote: l.lineNote ?? "",
    floorApproved: l.floorApproved ?? false,
    addedBy: l.addedBy,
  };
}

export function isoToDateInput(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "";
}

/** Date input (yyyy-mm-dd) -> ISO timestamp at the end of that day UTC, or null. */
export function dateInputToIso(date: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T23:59:59.000Z` : null;
}

export function stateFromQuote(q: StaffQuote): EditorState {
  return {
    lines: [...q.workingLines].sort((a, b) => a.position - b.position).map(toEditorLine),
    freightCents: parseMoney(q.workingFreight) ?? 0,
    expiresOn: isoToDateInput(q.expiresAt),
    repNote: q.workingRepNote ?? "",
    internalNote: q.workingInternalNote ?? "",
  };
}

export function toDraftRequest(s: EditorState): DraftRevisionRequest {
  return {
    lines: s.lines.map((l) => ({
      ...(l.id ? { id: l.id } : {}),
      variantId: l.variantId,
      qty: l.qty,
      quotedPrice: toMoneyString(l.quotedPriceCents),
      lineNote: l.lineNote.trim() === "" ? null : l.lineNote,
    })),
    freight: toMoneyString(s.freightCents),
    expiresAt: dateInputToIso(s.expiresOn),
    repNote: s.repNote.trim() === "" ? null : s.repNote,
    internalNote: s.internalNote.trim() === "" ? null : s.internalNote,
  };
}

/** True when the editor differs from the last saved/loaded state. Compares the request payloads. */
export function isDirty(current: EditorState, saved: EditorState): boolean {
  return JSON.stringify(toDraftRequest(current)) !== JSON.stringify(toDraftRequest(saved));
}

/** Validation errors blocking Save / Send. Empty array = fine. */
export function validateEditor(s: EditorState): string[] {
  const errors: string[] = [];
  if (s.lines.length === 0) errors.push("Add at least one line item.");
  s.lines.forEach((l) => {
    if (!Number.isInteger(l.qty) || l.qty < 1) errors.push(`${l.title}: quantity must be 1 or more.`);
    if (l.quotedPriceCents < 0) errors.push(`${l.title}: price cannot be negative.`);
  });
  if (s.freightCents < 0) errors.push("Freight cannot be negative.");
  return errors;
}

export type LineChange = { kind: "new" } | { kind: "qty"; from: number } | { kind: "price"; from: number };

/**
 * Compare working lines with the latest sent version (matched by variant) for the "New in v2" and
 * "qty 24 -> 16" hints from the mockup.
 */
export function diffAgainstVersion(
  lines: readonly EditorLine[],
  previous: readonly Pick<StaffQuoteLine, "variantId" | "qty" | "quotedPrice">[] | undefined,
): Map<string, LineChange> {
  const out = new Map<string, LineChange>();
  if (!previous || previous.length === 0) return out;
  const byVariant = new Map(previous.map((p) => [p.variantId, p]));
  for (const l of lines) {
    const prev = byVariant.get(l.variantId);
    if (!prev) out.set(l.key, { kind: "new" });
    else if (prev.qty !== l.qty) out.set(l.key, { kind: "qty", from: prev.qty });
    else {
      const prevPrice = parseMoney(prev.quotedPrice);
      if (prevPrice !== null && prevPrice !== l.quotedPriceCents) out.set(l.key, { kind: "price", from: prevPrice });
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------- workflow / versions */

/** The version number "Send vN" will create. */
export function nextVersionNo(q: Pick<StaffQuote, "currentVersion" | "versions">): number {
  const fromVersions = q.versions.reduce((m, v) => Math.max(m, v.versionNo), 0);
  return Math.max(q.currentVersion ?? 0, fromVersions) + 1;
}

export interface QuoteActions {
  canClaim: boolean;
  canSend: boolean;
  canReopen: boolean;
  canDecline: boolean;
  /** Working lines are editable only while sales owns the next move. */
  canEdit: boolean;
}

/** Derived from the shared state machine so the UI never invents transitions. */
export function quoteActions(status: QuoteStatus): QuoteActions {
  const canSend = canTransition(status, "SEND_REVISION", "staff");
  return {
    canClaim: canTransition(status, "CLAIM", "staff"),
    canSend,
    canReopen: canTransition(status, "REOPEN", "staff"),
    canDecline: canTransition(status, "DECLINE", "staff"),
    canEdit: canSend,
  };
}

/* ------------------------------------------------------------------------------------- display */

export const STATUS_LABEL: Record<QuoteStatus, string> = {
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

export type Tone = "info" | "warning" | "success" | "critical" | "neutral" | "caution";

export const STATUS_TONE: Record<QuoteStatus, Tone> = {
  DRAFT: "neutral",
  SUBMITTED: "info",
  IN_REVIEW: "info",
  QUOTE_READY: "success",
  CHANGES_REQUESTED: "caution",
  ACCEPTED: "success",
  ORDERED: "success",
  EXPIRED: "neutral",
  DECLINED: "critical",
  ARCHIVED: "neutral",
};

/** "3h 10m", "48m", "2d 4h", "<1m". Negative or missing input returns "". */
export function waitingLabel(sinceIso: string | null | undefined, now: Date = new Date()): string {
  if (!sinceIso) return "";
  const ms = now.getTime() - new Date(sinceIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "<1m";
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** Waiting longer than this on sales' side is highlighted (4 hours). */
export const WAITING_WARN_MINUTES = 60;
export const WAITING_CRITICAL_MINUTES = 240;

export function waitingSeverity(sinceIso: string | null | undefined, now: Date = new Date()): "none" | "warn" | "critical" {
  if (!sinceIso) return "none";
  const mins = (now.getTime() - new Date(sinceIso).getTime()) / 60000;
  if (!Number.isFinite(mins) || mins < WAITING_WARN_MINUTES) return "none";
  return mins >= WAITING_CRITICAL_MINUTES ? "critical" : "warn";
}

export const INBOX_TABS: { id: InboxTab; label: string }[] = [
  { id: "needs_response", label: "Needs response" },
  { id: "unassigned", label: "Unassigned" },
  { id: "waiting_customer", label: "Waiting on customer" },
  { id: "accepted", label: "Accepted" },
  { id: "expiring", label: "Expiring" },
  { id: "all", label: "All" },
];

export function isInboxTab(v: string | null | undefined): v is InboxTab {
  return INBOX_TABS.some((t) => t.id === v);
}

/** Tab badge counts that the summary endpoint can provide. Others are undefined (no badge). */
export function tabCount(tab: InboxTab, s: StaffSummary | null | undefined): number | undefined {
  if (!s) return undefined;
  switch (tab) {
    case "needs_response":
      return s.needsResponse;
    case "unassigned":
      return s.unassigned;
    case "accepted":
      return s.acceptedThisWeek;
    case "expiring":
      return s.expiringSoon;
    default:
      return undefined;
  }
}

/** Whole-dollar display for tiles: 6421000 cents -> "$64,210". Input is an API Money string. */
export function formatMoneyWhole(money: string | null | undefined): string {
  const cents = parseMoney(money ?? "");
  if (cents === null) return "$0";
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${Math.round(Math.abs(cents) / 100).toLocaleString("en-US")}`;
}

export function formatPct(p: number | null | undefined): string {
  return p === null || p === undefined ? "n/a" : `${p.toFixed(1)}%`;
}

/** Extract the numeric part from "Q-10482" / "q-10482" / "10482". */
export function parseQuoteNumber(input: string): number | null {
  const m = /^\s*q?-?(\d{1,10})\s*$/i.exec(input);
  return m ? Number(m[1]) : null;
}
