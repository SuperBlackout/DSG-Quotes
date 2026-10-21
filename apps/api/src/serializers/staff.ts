import type { Event, Job, Message, Quote, QuoteLine, QuoteVersion, Staff } from "@prisma/client";
import { waitingOn, type QuoteStatus } from "shared";
import type { Schemas } from "shared";
import { isBelowFloor, isCostUnknown } from "../domain/lines";
import { computeTotals, fmt, fmtOrNull, lineTotal, marginPctOf, type Decimal } from "../domain/money";
import { asAttachments, asEmails, displayNumber } from "./customer";

/** STAFF serializers: include cost, margin, internal notes. Only used by /s routes. */

const iso = (d: Date) => d.toISOString();
const dateOnly = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export function staffLine(l: QuoteLine, floor: Decimal): Schemas["StaffQuoteLine"] {
  return {
    id: l.id,
    variantId: l.variantId,
    sku: l.sku,
    title: l.title,
    imageUrl: l.imageUrl,
    qty: l.qty,
    listPrice: fmt(l.listPrice),
    quotedPrice: fmt(l.quotedPrice),
    cost: fmtOrNull(l.cost),
    lineTotal: fmt(lineTotal(l)),
    marginPct: marginPctOf(l.quotedPrice, l.cost),
    belowFloor: isBelowFloor(l, floor),
    costUnknown: isCostUnknown(l),
    floorApproved: l.floorApproved,
    lineNote: l.lineNote,
    addedBy: l.addedBy,
    position: l.position,
  };
}

export function staffVersion(v: QuoteVersion & { lines: QuoteLine[] }, floor: Decimal): Schemas["StaffQuoteVersion"] {
  const t = computeTotals(v.lines, v.freight);
  return {
    versionNo: v.versionNo,
    sentAt: iso(v.sentAt),
    sentById: v.sentById,
    subtotal: fmt(v.subtotal),
    discountTotal: fmt(v.discountTotal),
    freight: fmt(v.freight),
    taxEstimate: fmtOrNull(v.taxEstimate),
    total: fmt(v.total),
    marginTotal: fmtOrNull(t.marginTotal),
    marginPct: t.marginPct,
    repNote: v.repNote,
    internalNote: v.internalNote,
    lines: v.lines.slice().sort((a, b) => a.position - b.position).map((l) => staffLine(l, floor)),
  };
}

export function staffMessage(m: Message): Schemas["StaffMessage"] {
  return {
    id: m.id,
    authorType: m.authorType,
    authorId: m.authorId,
    authorName: m.authorName,
    body: m.body,
    internal: m.internal,
    attachments: asAttachments(m.attachments),
    channel: m.channel,
    readAt: m.readAt ? iso(m.readAt) : null,
    createdAt: iso(m.createdAt),
  };
}

type QuoteRow = Quote & { job: Job | null; assignedRep: Staff | null };

export function staffSummary(q: QuoteRow): Schemas["StaffQuoteSummary"] {
  const s = q.status as QuoteStatus;
  return {
    id: q.id,
    number: q.number,
    displayNumber: displayNumber(q.number),
    title: q.title,
    status: q.status,
    waitingOn: waitingOn(s),
    waitingSince: waitingOn(s) === "none" ? null : iso(q.statusChangedAt),
    customerName: q.customerName,
    companyName: q.companyName,
    jobName: q.job?.name ?? null,
    assignedRepId: q.assignedRepId,
    assignedRepName: q.assignedRep?.name ?? null,
    teamId: q.teamId,
    currentVersion: q.currentVersion,
    itemCount: q.lineCount,
    currencyCode: q.currencyCode,
    total: fmt(q.total),
    marginPct: q.marginPct == null ? null : Number(q.marginPct.toString()),
    belowFloor: q.belowFloor,
    expiresAt: q.expiresAt ? iso(q.expiresAt) : null,
    updatedAt: iso(q.updatedAt),
  };
}

export interface StaffQuoteParts {
  quote: QuoteRow;
  working: QuoteLine[];
  versions: (QuoteVersion & { lines: QuoteLine[] })[];
  messages: Message[];
  events: Event[];
  floor: Decimal;
  latestChangeRequest: string | null;
  nextVersionNo: number;
}

export function staffQuote(p: StaffQuoteParts): Schemas["StaffQuote"] {
  const q = p.quote;
  return {
    ...staffSummary(q),
    customerId: q.customerId,
    customerContactName: q.customerName || null,
    customerContactPhone: q.customerContactPhone,
    paymentTerms: q.paymentTerms,
    nextVersionNo: p.nextVersionNo,
    companyId: q.companyId,
    companyLocationId: q.companyLocationId,
    job: q.job ? { id: q.job.id, name: q.job.name, poNumber: q.job.poNumber, siteAddress: q.job.siteAddress } : null,
    poNumber: q.poNumber ?? q.job?.poNumber ?? null,
    neededBy: dateOnly(q.neededBy),
    shipTo: (q.shipToAddress as Schemas["Address"] | null) ?? null,
    notesToSales: q.notesToSales,
    watchers: asEmails(q.watchers),
    draftOrderId: q.draftOrderId,
    orderId: q.orderId,
    latestChangeRequest: p.latestChangeRequest,
    workingLines: p.working.slice().sort((a, b) => a.position - b.position).map((l) => staffLine(l, p.floor)),
    workingFreight: fmt(q.workingFreight),
    workingExpiresAt: q.workingExpiresAt ? iso(q.workingExpiresAt) : null,
    workingRepNote: q.workingRepNote,
    workingInternalNote: q.workingInternalNote,
    versions: p.versions.slice().sort((a, b) => a.versionNo - b.versionNo).map((v) => staffVersion(v, p.floor)),
    messages: p.messages.map(staffMessage),
    events: p.events.map((e) => ({
      id: e.id,
      type: e.type,
      actorType: e.actorType,
      actorId: e.actorId,
      payload: (e.payload ?? {}) as Record<string, unknown>,
      createdAt: iso(e.createdAt),
    })),
  };
}
