import { describe, expect, it } from "vitest";
import { addVariants, applyDiscountToAll, fromPickerItem, removeLine, setQty, setQuotedPrice, updateLine } from "./editor-ops";
import type { EditorLine, EditorState } from "./editor-state";

const line = (over: Partial<EditorLine> = {}): EditorLine => ({
  key: "a",
  id: "a",
  variantId: "v1",
  sku: "S1",
  title: "Thing",
  imageUrl: null,
  qty: 2,
  listPriceCents: 10000,
  costCents: 8000,
  quotedPriceCents: 9000,
  lineNote: "",
  floorApproved: true,
  ...over,
});
const state = (lines: EditorLine[] = [line()]): EditorState => ({ lines, freightCents: 0, expiresOn: "", repNote: "", internalNote: "" });

describe("picker conversion", () => {
  it("maps a variant selection", () => {
    expect(
      fromPickerItem({
        id: "gid://shopify/ProductVariant/1",
        title: "Blue",
        sku: "CBL-BL",
        price: "275.00",
        product: { title: "Cat6 Cable" },
        images: [{ originalSrc: "https://cdn.example/a.png" }],
      }),
    ).toEqual({
      variantId: "gid://shopify/ProductVariant/1",
      title: "Cat6 Cable - Blue",
      sku: "CBL-BL",
      priceCents: 27500,
      imageUrl: "https://cdn.example/a.png",
    });
  });

  it("handles default variants, missing fields and garbage", () => {
    expect(fromPickerItem({ id: "v", title: "Default Title", product: { title: "Rack Shelf" }, price: 70 })).toMatchObject({
      title: "Rack Shelf",
      priceCents: 7000,
      sku: null,
      imageUrl: null,
    });
    expect(fromPickerItem(null)).toBeNull();
    expect(fromPickerItem({ title: "x" })).toBeNull();
    expect(fromPickerItem({ id: "v" })).toMatchObject({ title: "Untitled item", priceCents: 0 });
  });
});

describe("editor ops", () => {
  const pick = { variantId: "v2", title: "New", sku: null, priceCents: 5000, imageUrl: null };

  it("adds a new line with unknown cost and list price as the quote price", () => {
    const s = addVariants(state(), [pick], () => "new-1");
    expect(s.lines).toHaveLength(2);
    expect(s.lines[1]).toMatchObject({ key: "new-1", qty: 1, costCents: null, costUnknown: false, listPriceCents: 5000, quotedPriceCents: 5000 });
    expect(s.lines[1]!.id).toBeUndefined();
  });

  it("bumps qty instead of duplicating a variant", () => {
    const s = addVariants(state(), [{ ...pick, variantId: "v1" }]);
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]!.qty).toBe(3);
  });

  it("clears floor approval when the price changes, keeps it when unchanged", () => {
    expect(setQuotedPrice(state(), "a", 8500).lines[0]!.floorApproved).toBe(false);
    expect(setQuotedPrice(state(), "a", 9000).lines[0]!.floorApproved).toBe(true);
  });

  it("clears floor approval on percent-off only for lines whose price moved", () => {
    const s = applyDiscountToAll(state([line(), line({ key: "b", id: "b", listPriceCents: 9000, quotedPriceCents: 9000 })]), 0);
    expect(s.lines[0]!.quotedPriceCents).toBe(10000);
    expect(s.lines[0]!.floorApproved).toBe(false);
    expect(s.lines[1]!.floorApproved).toBe(true);
  });

  it("sets qty only for valid input", () => {
    expect(setQty(state(), "a", "16").lines[0]!.qty).toBe(16);
    const same = state();
    expect(setQty(same, "a", "0")).toBe(same);
    expect(setQty(same, "a", "abc")).toBe(same);
  });

  it("removes and patches lines immutably", () => {
    const s = state();
    expect(removeLine(s, "a").lines).toHaveLength(0);
    expect(s.lines).toHaveLength(1);
    expect(updateLine(s, "a", { lineNote: "hi" }).lines[0]!.lineNote).toBe("hi");
  });
});
