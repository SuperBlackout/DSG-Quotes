// Screen 4 view model: which version is on screen, its totals, and the diff against the one before.
import type { CustomerQuote, CustomerQuoteLine, CustomerQuoteVersion, Money } from "../api/types";
import { diffVersions, previousVersion, type VersionDiff } from "./diff";
import { formatShortDate, fromCents, sumCents } from "./format";

export interface VersionTab {
  versionNo: number;
  /** "v1 · Oct 18" or "v2 · current" */
  label: string;
  isCurrent: boolean;
}

export interface DetailView {
  /** Undefined while the quote is an unsent draft. */
  versionNo?: number;
  isCurrent: boolean;
  lines: CustomerQuoteLine[];
  subtotal: Money;
  discountTotal?: Money;
  freight?: Money;
  taxEstimate?: Money | null;
  total: Money;
  repNote?: string | null;
  sentAt?: string;
  /** Diff against the previous version; empty/no-op for v1 and drafts. */
  diff: VersionDiff;
  /** Number of the version the diff compares against, when there is one. */
  comparedTo?: number;
}

export function currentVersionNo(q: Pick<CustomerQuote, "currentVersion" | "versions">): number | undefined {
  if (q.currentVersion) return q.currentVersion;
  const last = q.versions[q.versions.length - 1];
  return last?.versionNo;
}

export function versionTabs(q: CustomerQuote, now: Date = new Date(), timeZone?: string): VersionTab[] {
  const current = currentVersionNo(q);
  return [...q.versions]
    .sort((a, b) => a.versionNo - b.versionNo)
    .map((v) => {
      const isCurrent = v.versionNo === current;
      return {
        versionNo: v.versionNo,
        isCurrent,
        label: `v${v.versionNo} · ${isCurrent ? "current" : formatShortDate(v.sentAt, now, timeZone)}`,
      };
    });
}

export function buildDetailView(q: CustomerQuote, selected?: number): DetailView {
  const current = currentVersionNo(q);
  const wanted = selected ?? current;
  const version: CustomerQuoteVersion | undefined = q.versions.find((v) => v.versionNo === wanted);

  if (!version) {
    // Unsent draft: only the working lines exist.
    const subtotal = fromCents(sumCents(q.lines.map((l) => l.lineTotal)));
    return {
      isCurrent: true,
      lines: q.lines,
      subtotal,
      total: q.total,
      diff: diffVersions(undefined, { versionNo: 0, sentAt: q.updatedAt, subtotal, discountTotal: "0.00", freight: "0.00", total: q.total, lines: q.lines }),
    };
  }

  const prev = previousVersion(q.versions, version.versionNo);
  const view: DetailView = {
    versionNo: version.versionNo,
    isCurrent: version.versionNo === current,
    lines: version.lines,
    subtotal: version.subtotal,
    discountTotal: version.discountTotal,
    freight: version.freight,
    taxEstimate: version.taxEstimate ?? null,
    total: version.total,
    repNote: version.repNote ?? null,
    sentAt: version.sentAt,
    diff: diffVersions(prev, version),
  };
  if (prev) view.comparedTo = prev.versionNo;
  return view;
}

