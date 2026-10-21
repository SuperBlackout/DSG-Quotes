import type { Job, Message, Quote, QuoteLine, QuoteVersion, Staff } from "@prisma/client";
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

export function customerActions(q: Pick<Quote, "status" | "expiresAt" | "lineCount">, now: Date): Schemas["CustomerQuoteActions"] {
  const s = q.status as QuoteStatus;
  const expired = !!q.expiresAt && q.expiresAt.getTime() <= now.getTime();
  return {
    canEditLines: customerCanEditLines(s),
    canSubmit: canTransition(s, "SUBMIT", "customer") && q.lineCount > 0,
    canWithdraw: canTransition(s, "WITHDRAW", "customer"),
    canAccept: canTransition(s, "ACCEPT", "customer") && !expired,
    canRequestChanges: canTransition(s, "REQUEST_CHANGES", "customer"),
    canBuy: isPurchasable(s, q.expiresAt, now),
    canReopen: canTransition(s, "REOPEN", "customer"),
    canDelete: canTransition(s, "DELETE", "customer"),
    canDecline: canTransition(s, "DECLINE", "customer"),
  };
}

type QuoteWithJob = Quote & { job: Job | null };

function jobRef(job: Job | null): Schemas["JobRef"] | null {
  return job ? { id: job.id, name: job.name, poNumber: job.poNumber, siteAddress: job.siteAddress } : null;
}

export function customerSummary(q: QuoteWithJob, now: Date): Schemas["CustomerQuoteSummary"] {
  return {
    id: q.id,
    number: q.number,
    displayNumber: displayNumber(q.number),
    title: q.title,
    status: q.status,
    waitingOn: waitingOn(q.status as QuoteStatus),
    job: jobRef(q.job),
    currentVersion: q.currentVersion,
    lineCount: q.lineCount,
    total: fmt(q.total),
    expiresAt: q.expiresAt ? iso(q.expiresAt) : null,
    ownerName: q.customerName,
    orderId: q.orderId,
    updatedAt: iso(q.updatedAt),
    actions: customerActions(q, now),
  };
}

export interface CustomerQuoteParts {
  quote: QuoteWithJob;
  rep: Pick<Staff, "name"> | null;
  lines: QuoteLine[];
  versions: (QuoteVersion & { lines: QuoteLine[] })[];
  messages: Message[];
}

export function customerQuote(p: CustomerQuoteParts, now: Date): Schemas["CustomerQuote"] {
  const q = p.quote;
  return {
    ...customerSummary(q, now),
    poNumber: q.poNumber ?? q.job?.poNumber ?? null,
    neededBy: dateOnly(q.neededBy),
    shipTo: (q.shipToAddress as Schemas["Address"] | null) ?? null,
    notesToSales: q.notesToSales,
    watchers: asEmails(q.watchers),
    assignedRepName: p.rep?.name ?? null,
    lines: p.lines.slice().sort((a, b) => a.position - b.position).map(customerLine),
    versions: p.versions.slice().sort((a, b) => a.versionNo - b.versionNo).map(customerVersion),
    // Defence in depth: internal notes are filtered in the query AND here.
    messages: p.messages.filter((m) => !m.internal).map(customerMessage),
  };
}

export function asEmails(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
