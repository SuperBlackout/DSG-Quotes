/**
 * The checkout flow tags every quote-derived draft order `quote:Q-#####` (docs/PLAN.md, "Accept to buy").
 * Tag matching in Shopify is case-insensitive in the admin, so match the same way here.
 */
export function quoteNumberFromTags(tags: readonly string[] | null | undefined): number | null {
  for (const raw of tags ?? []) {
    const m = /^\s*quote:\s*Q-(\d{1,10})\s*$/i.exec(raw);
    if (m) return Number(m[1]);
  }
  return null;
}

export function displayNumber(n: number): string {
  return `Q-${n}`;
}

/** In-app path handled by app/src/routes/app.q.$number.tsx. Used with the `app:` link protocol. */
export function quoteAppLink(n: number): string {
  return `app:q/${n}`;
}
