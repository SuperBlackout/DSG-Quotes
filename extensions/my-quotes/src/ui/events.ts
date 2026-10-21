// The component typings give change/input handlers a plain `Event`; the value lives on the element
// that fired it (`currentTarget`), as in Shopify's examples. These helpers read it without `any`.

export function valueOf(e: Event): string {
  const v = (e.currentTarget as unknown as { value?: unknown } | null)?.value;
  return typeof v === "string" ? v : "";
}

export function checkedOf(e: Event): boolean {
  return (e.currentTarget as unknown as { checked?: unknown } | null)?.checked === true;
}

/** Files chosen in an s-drop-zone. */
export function filesOf(e: Event): File[] {
  const f = (e.currentTarget as unknown as { files?: unknown } | null)?.files;
  return Array.isArray(f) ? (f as File[]) : [];
}
