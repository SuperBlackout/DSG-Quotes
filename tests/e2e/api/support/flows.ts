/**
 * Reusable scenario steps. Each helper asserts the status it expects so a broken precondition fails loudly
 * at the step that broke instead of three assertions later.
 */
import * as F from "./fixtures";
import type { Actor, Res, World } from "./world";

export function ok(r: Res, status: number | number[], what: string): any {
  const want = Array.isArray(status) ? status : [status];
  if (!want.includes(r.status)) throw new Error(`${what}: expected ${want.join("/")}, got ${r.status} ${r.text.slice(0, 400)}`);
  return r.body;
}

export interface Line {
  variantId: string;
  qty: number;
}

/** Customer creates a draft with a new job and adds lines (Screen 1: PDP "Add to Quote" -> "Start a new quote"). */
export async function draftWith(
  who: Actor,
  lines: Line[] = [{ variantId: F.V_PIPE, qty: 4 }],
  o: { title?: string; job?: string; po?: string } = {},
): Promise<any> {
  const created = ok(
    await who.post("/c/quotes", {
      title: o.title ?? "Riverside build",
      newJob: { name: o.job ?? "Riverside Apartments", poNumber: o.po ?? "PO-7731" },
      poNumber: o.po ?? "PO-7731",
    }),
    201,
    "create draft",
  );
  let q = created;
  for (const l of lines) q = ok(await who.post(`/c/quotes/${created.id}/lines`, l), 201, "add line");
  return q;
}

export async function submitted(who: Actor, lines?: Line[], o?: { title?: string; job?: string; po?: string }): Promise<any> {
  const d = await draftWith(who, lines, o);
  return ok(await who.post(`/c/quotes/${d.id}/submit`, { notesToSales: "Need this by the 20th" }), 200, "submit");
}

/** Rep claims the quote, optionally reprices lines (variantId -> price) and saves the working revision. */
export async function claimAndPrice(
  rep: Actor,
  quoteId: string,
  prices: Record<string, string> = {},
  extra: { freight?: string; repNote?: string | null; internalNote?: string | null; expiresAt?: string | null } = {},
): Promise<any> {
  const claimed = ok(await rep.post(`/s/quotes/${quoteId}/claim`), 200, "claim");
  const lines = claimed.workingLines.map((l: any) => ({ id: l.id, variantId: l.variantId, qty: l.qty, quotedPrice: prices[l.variantId] ?? l.quotedPrice, lineNote: l.lineNote }));
  return ok(await rep.put(`/s/quotes/${quoteId}/draft-revision`, { lines, ...extra }), 200, "save draft revision");
}

/** Save a new working revision on an already claimed quote (no claim call). */
export async function reprice(
  rep: Actor,
  quoteId: string,
  prices: Record<string, string>,
  extra: { freight?: string; repNote?: string | null; internalNote?: string | null; expiresAt?: string | null; qty?: Record<string, number> } = {},
): Promise<any> {
  const cur = ok(await rep.get(`/s/quotes/${quoteId}`), 200, "load staff quote");
  const { qty, ...rest } = extra;
  const lines = cur.workingLines.map((l: any) => ({ id: l.id, variantId: l.variantId, qty: qty?.[l.variantId] ?? l.qty, quotedPrice: prices[l.variantId] ?? l.quotedPrice, lineNote: l.lineNote }));
  return ok(await rep.put(`/s/quotes/${quoteId}/draft-revision`, { lines, ...rest }), 200, "save draft revision");
}

/** Submitted -> claimed -> priced -> sent. Returns the customer's view of the quote. */
export async function sentQuote(
  w: World,
  o: { lines?: Line[]; prices?: Record<string, string>; customer?: Actor; rep?: Actor; freight?: string } = {},
): Promise<any> {
  const who = o.customer ?? w.dana;
  const rep = o.rep ?? w.rep1;
  const q = await submitted(who, o.lines);
  await claimAndPrice(rep, q.id, o.prices ?? {}, o.freight ? { freight: o.freight } : {});
  ok(await rep.post(`/s/quotes/${q.id}/send`), 200, "send");
  return ok(await who.get(`/c/quotes/${q.id}`), 200, "customer view");
}

export async function acceptedQuote(w: World, o: Parameters<typeof sentQuote>[1] = {}): Promise<any> {
  const who = o.customer ?? w.dana;
  const q = await sentQuote(w, o);
  return ok(await who.post(`/c/quotes/${q.id}/accept`, { versionNo: q.currentVersion }), 200, "accept");
}

/** Line-level diff between two sent versions, the way the My Quotes "highlight changes" view derives it. */
export function diffVersions(prev: any, next: any) {
  const byVariant = (v: any) => new Map<string, any>(v.lines.map((l: any) => [l.variantId, l]));
  const a = byVariant(prev);
  const b = byVariant(next);
  const changes: { variantId: string; change: "added" | "removed" | "price" | "qty"; from?: string | number; to?: string | number }[] = [];
  for (const [id, line] of b) {
    const old = a.get(id);
    if (!old) changes.push({ variantId: id, change: "added", to: line.quotedPrice });
    else {
      if (old.quotedPrice !== line.quotedPrice) changes.push({ variantId: id, change: "price", from: old.quotedPrice, to: line.quotedPrice });
      if (old.qty !== line.qty) changes.push({ variantId: id, change: "qty", from: old.qty, to: line.qty });
    }
  }
  for (const id of a.keys()) if (!b.has(id)) changes.push({ variantId: id, change: "removed" });
  return changes;
}

export const eventTypes = async (w: World, quoteId: string, type?: string) =>
  (await w.prisma.event.findMany({ where: { quoteId, ...(type ? { type } : {}) }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map((e) => e.type);

export const eventRows = (w: World, quoteId: string, type?: string) =>
  w.prisma.event.findMany({ where: { quoteId, ...(type ? { type } : {}) }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

/** Order webhook payload for a quote, shaped like Shopify's orders/create (tag is how the app matches it). */
export const orderPayload = (quoteNumber: number, orderId = 9001, extra: object = {}) => ({
  id: orderId,
  admin_graphql_api_id: `gid://shopify/Order/${orderId}`,
  tags: `wholesale, quote:Q-${quoteNumber}`,
  source_name: "shopify_draft_order",
  ...extra,
});
