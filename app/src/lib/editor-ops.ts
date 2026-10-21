/** Pure state operations for the quote editor (immutable updates). */
import type { EditorLine, EditorState } from "./editor-state";
import { applyPercentOff, parseMoney, parseQty } from "./pricing";

export interface PickedVariant {
  variantId: string;
  title: string;
  sku: string | null;
  priceCents: number;
  imageUrl: string | null;
}

/**
 * Convert one item returned by App Bridge `shopify.resourcePicker({ type: "variant" })` into a PickedVariant.
 * Defensive on purpose: the picker payload shape is UNVERIFIED against a live store. Returns null if the
 * item has no usable id.
 */
export function fromPickerItem(item: unknown): PickedVariant | null {
  if (!item || typeof item !== "object") return null;
  const v = item as Record<string, unknown>;
  const id = typeof v["id"] === "string" ? v["id"] : null;
  if (!id) return null;
  const product = (v["product"] ?? {}) as Record<string, unknown>;
  const productTitle = typeof product["title"] === "string" ? product["title"] : "";
  const variantTitle = typeof v["displayName"] === "string" ? v["displayName"] : typeof v["title"] === "string" ? v["title"] : "";
  const isDefault = variantTitle === "" || variantTitle === "Default Title";
  const title = isDefault
    ? productTitle || "Untitled item"
    : productTitle && !variantTitle.startsWith(productTitle)
      ? `${productTitle} - ${variantTitle}`
      : variantTitle;
  const images = Array.isArray(v["images"]) ? (v["images"] as Record<string, unknown>[]) : [];
  const productImages = Array.isArray(product["images"]) ? (product["images"] as Record<string, unknown>[]) : [];
  const img = [images[0], productImages[0], v["image"] as Record<string, unknown> | undefined].find(
    (i) => i && typeof (i["originalSrc"] ?? i["url"]) === "string",
  );
  return {
    variantId: id,
    title,
    sku: typeof v["sku"] === "string" && v["sku"] !== "" ? v["sku"] : null,
    priceCents: parseMoney(typeof v["price"] === "string" || typeof v["price"] === "number" ? (v["price"] as string | number) : "") ?? 0,
    imageUrl: img ? String(img["originalSrc"] ?? img["url"]) : null,
  };
}

let seq = 0;
export function newLineKey(): string {
  seq += 1;
  return `new-${seq}`;
}

/** Add picked variants. A variant already on the quote gets +1 qty instead of a duplicate line. */
export function addVariants(state: EditorState, picks: readonly PickedVariant[], keyFn: () => string = newLineKey): EditorState {
  let lines = state.lines;
  for (const p of picks) {
    const existing = lines.find((l) => l.variantId === p.variantId);
    if (existing) {
      lines = lines.map((l) => (l === existing ? { ...l, qty: l.qty + 1 } : l));
    } else {
      lines = [
        ...lines,
        {
          key: keyFn(),
          variantId: p.variantId,
          sku: p.sku,
          title: p.title,
          imageUrl: p.imageUrl,
          qty: 1,
          listPriceCents: p.priceCents,
          // Cost is unknown until the first save: the server snapshots it (CLAUDE.md rule 6) and returns it.
          costCents: null,
          quotedPriceCents: p.priceCents,
          lineNote: "",
          floorApproved: false,
          addedBy: "STAFF",
        } satisfies EditorLine,
      ];
    }
  }
  return { ...state, lines };
}

export function updateLine(state: EditorState, key: string, patch: Partial<EditorLine>): EditorState {
  return { ...state, lines: state.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) };
}

/** Changing the quoted price invalidates any earlier floor approval for that line. */
export function setQuotedPrice(state: EditorState, key: string, cents: number): EditorState {
  return {
    ...state,
    lines: state.lines.map((l) =>
      l.key === key ? { ...l, quotedPriceCents: cents, floorApproved: l.quotedPriceCents === cents ? l.floorApproved : false } : l,
    ),
  };
}

export function setQty(state: EditorState, key: string, text: string): EditorState {
  const qty = parseQty(text);
  return qty === null ? state : updateLine(state, key, { qty });
}

export function removeLine(state: EditorState, key: string): EditorState {
  return { ...state, lines: state.lines.filter((l) => l.key !== key) };
}

export function applyDiscountToAll(state: EditorState, pct: number): EditorState {
  const next = applyPercentOff(state.lines, pct);
  return { ...state, lines: next.map((l, i) => (l.quotedPriceCents === state.lines[i]!.quotedPriceCents ? l : { ...l, floorApproved: false })) };
}
