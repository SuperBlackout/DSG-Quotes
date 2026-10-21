import { describe, expect, it } from "vitest";
import { buildDetailView, canEditJobDetails, currentVersionNo, versionTabs } from "../src/lib/detail";
import { line, quote, version } from "./fixtures";

const v1 = version({
  versionNo: 1,
  sentAt: "2026-10-18T15:00:00.000Z",
  subtotal: "3700.00",
  freight: "212.00",
  total: "3912.00",
  lines: [line({ variantId: "a", qty: 24, lineTotal: "3700.00" })],
});
const v2 = version({
  versionNo: 2,
  sentAt: "2026-10-21T10:00:00.000Z",
  subtotal: "3495.00",
  discountTotal: "0.00",
  freight: "145.00",
  taxEstimate: null,
  total: "3640.00",
  repNote: "Amps at qty-break price.",
  lines: [line({ variantId: "a", qty: 12, lineTotal: "3495.00" })],
});
const q = quote({ status: "QUOTE_READY", currentVersion: 2, total: "3640.00", versions: [v1, v2], lines: v2.lines });

describe("versionTabs", () => {
  it("labels old versions by date and the live one as current", () => {
    const tabs = versionTabs(q, new Date("2026-10-21T12:00:00.000Z"), "UTC");
    expect(tabs.map((t) => t.label)).toEqual(["v1 · Oct 18", "v2 · current"]);
    expect(tabs.map((t) => t.isCurrent)).toEqual([false, true]);
  });

  it("is empty for a draft", () => {
    expect(versionTabs(quote({ status: "DRAFT" }))).toEqual([]);
  });
});

describe("buildDetailView", () => {
  it("defaults to the current version and diffs it against the previous one", () => {
    const view = buildDetailView(q);
    expect(view.versionNo).toBe(2);
    expect(view.isCurrent).toBe(true);
    expect(view.comparedTo).toBe(1);
    expect(view.diff.totalFrom).toBe("3912.00");
    expect(view.diff.lines[0]).toMatchObject({ kind: "changed", qtyFrom: 24 });
    expect(view.freight).toBe("145.00");
    expect(view.repNote).toBe("Amps at qty-break price.");
  });

  it("shows an older version with its own totals and nothing to compare against", () => {
    const view = buildDetailView(q, 1);
    expect(view.versionNo).toBe(1);
    expect(view.isCurrent).toBe(false);
    expect(view.total).toBe("3912.00");
    expect(view.comparedTo).toBeUndefined();
    expect(view.diff.hasChanges).toBe(false);
  });

  it("builds a draft view from working lines, with subtotal from line totals", () => {
    const draft = quote({
      status: "DRAFT",
      total: "300.00",
      lines: [line({ variantId: "x", lineTotal: "100.00" }), line({ variantId: "y", lineTotal: "200.00" })],
    });
    const view = buildDetailView(draft);
    expect(view.versionNo).toBeUndefined();
    expect(view.subtotal).toBe("300.00");
    expect(view.total).toBe("300.00");
    expect(view.diff.hasChanges).toBe(false);
  });

  it("falls back to the last version when currentVersion is missing", () => {
    expect(currentVersionNo({ currentVersion: undefined, versions: [v1, v2] })).toBe(2);
  });
});

describe("canEditJobDetails", () => {
  it("is open while the quote is live and closed afterwards", () => {
    expect(canEditJobDetails("DRAFT")).toBe(true);
    expect(canEditJobDetails("QUOTE_READY")).toBe(true);
    expect(canEditJobDetails("ORDERED")).toBe(false);
    expect(canEditJobDetails("EXPIRED")).toBe(false);
  });
});
