import { describe, expect, it } from "vitest";
import { diffVersions, previousVersion, savingsCents } from "../src/lib/diff";
import { line, version } from "./fixtures";

// Mirrors mockup screen 4: v1 -> v2 of Q-10482.
const v1 = version({
  versionNo: 1,
  total: "3912.00",
  lines: [
    line({ variantId: "amp", qty: 2, listPrice: "799.00", quotedPrice: "749.00", lineTotal: "1498.00" }),
    line({ variantId: "spk65", qty: 24, listPrice: "62.00", quotedPrice: "58.00", lineTotal: "1392.00" }),
    line({ variantId: "cable", qty: 2, listPrice: "275.00", quotedPrice: "275.00", lineTotal: "550.00" }),
    line({ variantId: "vc", qty: 6, listPrice: "31.50", quotedPrice: "31.50", lineTotal: "189.00" }),
    line({ variantId: "old-widget", qty: 1, listPrice: "10.00", quotedPrice: "10.00", lineTotal: "10.00" }),
  ],
});

const v2 = version({
  versionNo: 2,
  total: "3640.00",
  lines: [
    line({ variantId: "amp", qty: 2, listPrice: "799.00", quotedPrice: "699.00", lineTotal: "1398.00" }),
    line({ variantId: "spk65", qty: 12, listPrice: "62.00", quotedPrice: "58.00", lineTotal: "696.00" }),
    line({
      variantId: "spk80",
      qty: 8,
      listPrice: "84.00",
      quotedPrice: "78.00",
      lineTotal: "624.00",
      lineNote: "Better coverage for rooms 3-6",
    }),
    line({ variantId: "cable", qty: 2, listPrice: "275.00", quotedPrice: "275.00", lineTotal: "550.00" }),
    line({ variantId: "vc", qty: 6, listPrice: "31.50", quotedPrice: "31.50", lineTotal: "189.00", lineNote: "now with plates" }),
  ],
});

describe("diffVersions", () => {
  const diff = diffVersions(v1, v2);
  const byVariant = Object.fromEntries(diff.lines.map((l) => [l.line.variantId, l]));

  it("marks price-only changes and records the previous quoted price", () => {
    expect(byVariant.amp).toMatchObject({ kind: "changed", quotedPriceFrom: "749.00" });
    expect(byVariant.amp!.qtyFrom).toBeUndefined();
  });

  it("marks quantity changes and records the previous quantity", () => {
    expect(byVariant.spk65).toMatchObject({ kind: "changed", qtyFrom: 24 });
    expect(byVariant.spk65!.quotedPriceFrom).toBeUndefined();
  });

  it("marks lines that did not exist in the previous version as added", () => {
    expect(byVariant.spk80).toMatchObject({ kind: "added" });
  });

  it("leaves identical lines unchanged, noting note-only edits separately", () => {
    expect(byVariant.cable).toMatchObject({ kind: "unchanged", noteChanged: false });
    expect(byVariant.vc).toMatchObject({ kind: "unchanged", noteChanged: true });
  });

  it("lists lines the rep removed", () => {
    expect(diff.removed.map((l) => l.variantId)).toEqual(["old-widget"]);
  });

  it("reports the previous total only when it moved", () => {
    expect(diff.totalFrom).toBe("3912.00");
    expect(diff.hasChanges).toBe(true);
    expect(diffVersions(v2, v2).totalFrom).toBeUndefined();
  });

  it("compares money numerically, not textually", () => {
    const a = version({ versionNo: 1, total: "10.5", lines: [line({ variantId: "x", quotedPrice: "5.0" })] });
    const b = version({ versionNo: 2, total: "10.50", lines: [line({ variantId: "x", quotedPrice: "5.00" })] });
    const d = diffVersions(a, b);
    expect(d.hasChanges).toBe(false);
    expect(d.lines[0]!.kind).toBe("unchanged");
  });

  it("has no changes to show for the first version", () => {
    const d = diffVersions(undefined, v1);
    expect(d.hasChanges).toBe(false);
    expect(d.lines.every((l) => l.kind === "unchanged")).toBe(true);
    expect(d.removed).toEqual([]);
  });

  it("pairs duplicate variants in order instead of calling both added", () => {
    const a = version({
      versionNo: 1,
      lines: [line({ id: "1", variantId: "d", qty: 1 }), line({ id: "2", variantId: "d", qty: 2 })],
    });
    const b = version({
      versionNo: 2,
      lines: [line({ id: "1", variantId: "d", qty: 1 }), line({ id: "2", variantId: "d", qty: 2 })],
    });
    expect(diffVersions(a, b).hasChanges).toBe(false);
  });
});

describe("previousVersion", () => {
  it("picks the next-lower version regardless of array order", () => {
    const vs = [version({ versionNo: 3 }), version({ versionNo: 1 }), version({ versionNo: 2 })];
    expect(previousVersion(vs, 3)?.versionNo).toBe(2);
    expect(previousVersion(vs, 1)).toBeUndefined();
  });
});

describe("savingsCents", () => {
  it("sums (list - quoted) * qty", () => {
    // amp 2*(799-699)=200, spk65 12*(62-58)=48, spk80 8*(84-78)=48, others 0
    expect(savingsCents(v2.lines)).toBe(29600);
  });

  it("never goes negative when quoted exceeds list", () => {
    expect(savingsCents([line({ variantId: "z", qty: 2, listPrice: "10.00", quotedPrice: "12.00" })])).toBe(0);
  });
});
