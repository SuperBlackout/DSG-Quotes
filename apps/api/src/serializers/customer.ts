import type { Job, Message, Quote, QuoteComment, QuoteLine, QuoteVersion } from "@prisma/client";
import { canTransition, customerCanEditLines, isPurchasable, waitingOn, type QuoteStatus } from "shared";
import type { Schemas } from "shared";
import { fmt, fmtOrNull, lineTotal } from "../domain/money";

/**
 * CUSTOMER-SAFE serializers. Every output object is built field by field from an explicit whitelist: never
 * spread a database row here. Cost, margin, floor flags, internal notes and internal messages must not
 * appear (CLAUDE.md rules 4 and 5); test/serializers.test.ts enforces it on real responses.
 */

export const displayNumber = (n: number) => `Q-${n}`;
const iso = (d: Date) => d.toISOString();
const dateOnly = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export function customerLine(l: QuoteLine): Schemas["CustomerQuoteLine"] {
  return {
    id: l.id,
    variantId: l.variantId,
    sku: l.sku,
    title: l.title,
    imageUrl: l.imageUrl,
    qty: l.qty,
    listPrice: fmt(l.listPrice),
    quotedPrice: fmt(l.quotedPrice),
    lineTotal: fmt(lineTotal(l)),
    lineNote: l.lineNote,
    position: l.position,
    addedBy: l.addedBy === "CUSTOMER" ? "CUSTOMER" : "STAFF",
  };
}

/** Customer-safe comment. `internal` comments must never reach this function; callers filter, and so do we. */
export function customerComment(c: QuoteComment, viewerId: string): Schemas["CustomerLineComment"] {
  return {
    id: c.id,
    body: c.body,
    afterLineId: c.afterLineId,
    authorType: c.authorType === "CUSTOMER" ? "CUSTOMER" : "STAFF",
    authorName: c.authorName ?? (c.authorType === "CUSTOMER" ? "You" : "DSG"),
    mine: c.authorType === "CUSTOMER" && c.authorId === viewerId,
    createdAt: iso(c.createdAt),
  };
}

export function customerVersion(v: QuoteVersion & { lines: QuoteLine[] }): Schemas["CustomerQuoteVersion"] {
  return {
    versionNo: v.versionNo,
    sentAt: iso(v.sentAt),
    subtotal: fmt(v.subtotal),
    discountTotal: fmt(v.discountTotal),
    freight: fmt(v.freight),
    taxEstimate: fmtOrNull(v.taxEstimate),
    total: fmt(v.total),
    repNote: v.repNote,
    lines: v.lines.slice().sort((a, b) => a.position - b.position).map(customerLine),
  };
}

export function customerMessage(m: Message): Schemas["CustomerMessage"] {
  return {
    id: m.id,
    authorType: m.authorType,
    authorName: m.authorName,
    body: m.body,
    attachments: asAttachments(m.attachments),
    channel: m.channel,
    readAt: m.readAt ? iso(m.readAt) : null,
    createdAt: iso(m.createdAt),
  };
}

export function asAttachments(v: unknown): Schemas["Attachment"][] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((a) => {
    if (!a || typeof a !== "object") return [];
    const { url, name, size, mime } = a as Record<string, unknown>;
    if (typeof url !== "string" || typeof name !== "string" || typeof size !== "number" || typeof mime !== "string") return [];
    return [{ url, name, size, mime }];
  });
}

/** Per-quote values that need a query: computed by `summaryExtras` (domain/customerQuotes.ts). */
export interface SummaryExtras {
  assignedRepName: string | null;
  unreadCount: number;
  previousTotal: string | null;
}

export const NO_EXTRAS: SummaryExtras = { assignedRepName: null, unreadCount: 0, previousTotal: null };

export function customerActions(q: Pick<Quote, "status" | "expiresAt" | "lineCount"> & { customerReady?: boolean }, now: Date): Schemas["CustomerQuoteActions"] {
  const s = q.status as QuoteStatus;
  const expired = !!q.expiresAt && q.expiresAt.getTime() <= now.getTime();
  return {
    canEditLines: customerCanEditLines(s),
    // Header fields (job, PO, needed-by, ship-to, notes) are customer-editable on DRAFT only (not on a rep-shared quote).
    canEditHeader: s === "DRAFT",
    canSubmit: canTransition(s, "SUBMIT", "customer") && q.lineCount > 0,
    canWithdraw: canTransition(s, "WITHDRAW", "customer"),
    canAccept: canTransition(s, "ACCEPT", "customer") && !expired,
    canRequestChanges: canTransition(s, "REQUEST_CHANGES", "customer"),
    canBuy: isPurchasable(s, q.expiresAt, now),
    canReopen: canTransition(s, "REOPEN", "customer"),
    canDelete: canTransition(s, "DELETE", "customer"),
    canDecline: canTransition(s, "DECLINE", "customer"),
    canReorder: customerCanEditLines(s),
    canMarkReady: canTransition(s, "CUSTOMER_READY", "customer") && !q.customerReady,
  };
}

type QuoteWithJob = Quote & { job: Job | null };

function jobRef(job: Job | null): Schemas["JobRef"] | null {
  return job ? { id: job.id, name: job.name, poNumber: job.poNumber, siteAddress: job.siteAddress } : null;
}

export function customerSummary(q: QuoteWithJob, now: Date, extras: SummaryExtras = NO_EXTRAS): Schemas["CustomerQuoteSummary"] {
  return {
    id: q.id,
    number: q.number,
    displayNumber: displayNumber(q.number),
    title: q.title,
    status: q.status,
    waitingOn: waitingOn(q.status as QuoteStatus, { customerReady: q.customerReady }),
    job: jobRef(q.job),
    currentVersion: q.currentVersion,
    lineCount: q.lineCount,
    currencyCode: q.currencyCode,
    total: fmt(q.total),
    previousTotal: extras.previousTotal,
    expiresAt: q.expiresAt ? iso(q.expiresAt) : null,
    ownerName: q.customerName,
    assignedRepName: extras.assignedRepName,
    unreadCount: extras.unreadCount,
    orderId: q.orderId,
    updatedAt: iso(q.updatedAt),
    actions: customerActions(q, now),
  };
}

export interface CustomerQuoteParts {
  quote: QuoteWithJob;
  extras: SummaryExtras;
  lines: QuoteLine[];
  versions: (QuoteVersion & { lines: QuoteLine[] })[];
  messages: Message[];
  /** All comments of the quote; internal ones are dropped here. */
  comments?: QuoteComment[];
  viewerId?: string;
}

export function customerQuote(p: CustomerQuoteParts, now: Date): Schemas["CustomerQuote"] {
  const q = p.quote;
  return {
    ...customerSummary(q, now, p.extras),
    poNumber: q.poNumber ?? q.job?.poNumber ?? null,
    neededBy: dateOnly(q.neededBy),
    shipTo: (q.shipToAddress as Schemas["Address"] | null) ?? null,
    notesToSales: q.notesToSales,
    watchers: asEmails(q.watchers),
    rev: q.rev,
    customerReady: q.customerReady,
    sharedBy: q.createdByStaffId ? p.extras.assignedRepName : null,
    comments:
      q.status === "DRAFT" || q.status === "SHARED"
        ? (p.comments ?? []).filter((c) => !c.internal).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((c) => customerComment(c, p.viewerId ?? ""))
        : [],
    lines: p.lines.slice().sort((a, b) => a.position - b.position).map(customerLine),
    versions: p.versions.slice().sort((a, b) => a.versionNo - b.versionNo).map(customerVersion),
    // Defence in depth: internal notes are filtered in the query AND here.
    messages: p.messages.filter((m) => !m.internal).map(customerMessage),
  };
}

export function asEmails(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
