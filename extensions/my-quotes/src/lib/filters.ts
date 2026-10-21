// Screen 3: filter chips, search and grouping. Pure functions over the loaded list.
import type { CustomerQuoteSummary } from "../api/types";
import { formatCents, plural, toCents } from "./format";
import { statusLabel } from "./status";

export type ChipId = "all" | "waiting" | "sales" | "drafts" | "closed";

export const CHIPS: ReadonlyArray<{ id: ChipId; label: string }> = [
  { id: "all", label: "All" },
  { id: "waiting", label: "Waiting on you" },
  { id: "sales", label: "With sales" },
  { id: "drafts", label: "Drafts" },
  { id: "closed", label: "Closed" },
];

/**
 * Chips are driven by `waitingOn` + status (ISSUE-3), not by recomputing the state machine:
 *  - waiting: waitingOn=customer, excluding drafts (those have their own chip)
 *  - sales:   waitingOn=sales
 *  - drafts:  status DRAFT
 *  - closed:  waitingOn=none (ordered, expired, declined)
 */
export function matchesChip(q: CustomerQuoteSummary, chip: ChipId): boolean {
  switch (chip) {
    case "all":
      return true;
    case "waiting":
      return q.waitingOn === "customer" && q.status !== "DRAFT";
    case "sales":
      return q.waitingOn === "sales";
    case "drafts":
      return q.status === "DRAFT";
    case "closed":
      return q.waitingOn === "none";
  }
}

export function chipCounts(quotes: CustomerQuoteSummary[]): Record<ChipId, number> {
  const counts: Record<ChipId, number> = { all: 0, waiting: 0, sales: 0, drafts: 0, closed: 0 };
  for (const q of quotes) for (const c of CHIPS) if (matchesChip(q, c.id)) counts[c.id] += 1;
  return counts;
}

/** Case-insensitive match over quote number, title, job name, PO and status wording. */
export function matchesSearch(q: CustomerQuoteSummary, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  const hay = [
    q.displayNumber ?? `Q-${q.number}`,
    String(q.number),
    q.title,
    q.job?.name,
    q.job?.poNumber,
    statusLabel(q),
  ]
    .filter((s): s is string => !!s)
    .join("\n")
    .toLowerCase();
  return needle.split(/\s+/).every((word) => hay.includes(word));
}

export function filterQuotes(quotes: CustomerQuoteSummary[], chip: ChipId, term: string): CustomerQuoteSummary[] {
  return quotes.filter((q) => matchesChip(q, chip) && matchesSearch(q, term));
}

export type GroupBy = "job" | "status" | "none";

export interface QuoteGroup {
  key: string;
  title: string;
  /** Present when grouping by job. */
  job?: NonNullable<CustomerQuoteSummary["job"]>;
  quotes: CustomerQuoteSummary[];
  /** "2 quotes · $5,758.00" */
  summary: string;
}

const NO_JOB_KEY = "__no_job__";

function newestFirst(a: CustomerQuoteSummary, b: CustomerQuoteSummary): number {
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

function summarize(quotes: CustomerQuoteSummary[]): string {
  const total = quotes.reduce((acc, q) => acc + toCents(q.total), 0);
  return `${plural(quotes.length, "quote")} · ${formatCents(total, quotes[0]?.currencyCode)}`;
}

/** Groups are ordered by their most recently updated quote; quotes inside a group newest first. */
export function groupQuotes(quotes: CustomerQuoteSummary[], by: GroupBy): QuoteGroup[] {
  const sorted = [...quotes].sort(newestFirst);
  if (by === "none") {
    return sorted.length ? [{ key: "all", title: "", quotes: sorted, summary: summarize(sorted) }] : [];
  }

  const map = new Map<string, QuoteGroup>();
  for (const q of sorted) {
    let key: string;
    let title: string;
    let job: QuoteGroup["job"];
    if (by === "job") {
      key = q.job?.id ?? NO_JOB_KEY;
      title = q.job?.name ?? "No job";
      job = q.job ?? undefined;
    } else {
      key = q.status;
      title = statusLabel({ status: q.status, currentVersion: undefined });
    }
    let g = map.get(key);
    if (!g) {
      g = { key, title, quotes: [], summary: "" };
      if (job) g.job = job;
      map.set(key, g);
    }
    g.quotes.push(q);
  }
  const groups = [...map.values()];
  for (const g of groups) g.summary = summarize(g.quotes);
  return groups; // Map preserves insertion order = newest group first.
}

/** Header line under the page title: "Pure Vision · 7 quotes across 4 jobs" (company name not in contract). */
export function listSubtitle(quotes: CustomerQuoteSummary[]): string {
  const jobs = new Set(quotes.map((q) => q.job?.id ?? NO_JOB_KEY));
  return `${plural(quotes.length, "quote")} across ${plural(jobs.size, "job")}`;
}
