// "Highlight changes" between two sent versions of a quote (screen 4).
// Lines are matched by variantId: line ids are not guaranteed to be stable across revisions, and
// the variant is what the customer recognises. Duplicate variants in one version are paired in order.
import type { CustomerQuoteLine, CustomerQuoteVersion, Money } from "../api/types";
import { toCents } from "./format";

export type LineChangeKind = "added" | "changed" | "unchanged";

export interface LineChange {
  line: CustomerQuoteLine;
  kind: LineChangeKind;
  /** Previous quantity, set only when qty changed. */
  qtyFrom?: number;
  /** Previous quoted price, set only when the quoted price changed. */
  quotedPriceFrom?: Money;
  /** True when the rep's line note differs from the previous version. */
  noteChanged: boolean;
}

export interface VersionDiff {
  lines: LineChange[];
  /** Lines present in the previous version but not in this one. */
  removed: CustomerQuoteLine[];
  /** Previous total, set only when the total changed. */
  totalFrom?: Money;
  hasChanges: boolean;
}

/** Version a given version is compared with: the one with the next-lower versionNo, if any. */
export function previousVersion(
  versions: CustomerQuoteVersion[],
  versionNo: number,
): CustomerQuoteVersion | undefined {
  let best: CustomerQuoteVersion | undefined;
  for (const v of versions) {
    if (v.versionNo < versionNo && (!best || v.versionNo > best.versionNo)) best = v;
  }
  return best;
}

export function diffVersions(prev: CustomerQuoteVersion | undefined, cur: CustomerQuoteVersion): VersionDiff {
  if (!prev) {
    return {
      lines: cur.lines.map((line) => ({ line, kind: "unchanged" as const, noteChanged: false })),
      removed: [],
      hasChanges: false,
    };
  }

  const pool = new Map<string, CustomerQuoteLine[]>();
  for (const l of prev.lines) {
    const list = pool.get(l.variantId);
    if (list) list.push(l);
    else pool.set(l.variantId, [l]);
  }

  const lines: LineChange[] = cur.lines.map((line) => {
    const before = pool.get(line.variantId)?.shift();
    if (!before) return { line, kind: "added", noteChanged: false };

    const qtyChanged = before.qty !== line.qty;
    const priceChanged = toCents(before.quotedPrice) !== toCents(line.quotedPrice);
    const noteChanged = (before.lineNote ?? "") !== (line.lineNote ?? "");
    const change: LineChange = {
      line,
      kind: qtyChanged || priceChanged ? "changed" : "unchanged",
      noteChanged,
    };
    if (qtyChanged) change.qtyFrom = before.qty;
    if (priceChanged) change.quotedPriceFrom = before.quotedPrice;
    return change;
  });

  const removed = [...pool.values()].flat();
  const totalChanged = toCents(prev.total) !== toCents(cur.total);

  const diff: VersionDiff = {
    lines,
    removed,
    hasChanges:
      removed.length > 0 || totalChanged || lines.some((l) => l.kind !== "unchanged" || l.noteChanged),
  };
  if (totalChanged) diff.totalFrom = prev.total;
  return diff;
}

/** What the dealer saves versus list price, in cents: sum((listPrice - quotedPrice) * qty), never negative. */
export function savingsCents(lines: CustomerQuoteLine[]): number {
  const saved = lines.reduce((acc, l) => acc + (toCents(l.listPrice) - toCents(l.quotedPrice)) * l.qty, 0);
  return Math.max(0, saved);
}
