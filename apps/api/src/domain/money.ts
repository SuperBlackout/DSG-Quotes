import { Prisma } from "@prisma/client";

export type Decimal = Prisma.Decimal;
export const D = (v: Prisma.Decimal.Value): Decimal => new Prisma.Decimal(v);
export const ZERO = D(0);

const MONEY_RE = /^-?\d+(\.\d{1,2})?$/;

/** Parse an API money string ("1234.50" or "12"); throws on garbage. */
export function parseMoney(v: string): Decimal {
  if (!MONEY_RE.test(v)) throw new Error(`Invalid money value: ${v}`);
  return D(v);
}

/** Format as the API's 2-place decimal string. Rounds half up. */
export function fmt(v: Decimal | number | string | null | undefined): string {
  return D(v ?? 0).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2);
}

export function fmtOrNull(v: Decimal | null | undefined): string | null {
  return v == null ? null : fmt(v);
}

export interface PricedLine {
  qty: number;
  listPrice: Decimal;
  quotedPrice: Decimal;
  cost: Decimal | null;
}

export const lineTotal = (l: Pick<PricedLine, "qty" | "quotedPrice">): Decimal => l.quotedPrice.mul(l.qty);

/** (quoted - cost) / quoted * 100, or null when cost is unknown or quoted is not positive. */
export function marginPctOf(quoted: Decimal, cost: Decimal | null): number | null {
  if (cost == null || quoted.lte(0)) return null;
  return Number(quoted.sub(cost).div(quoted).mul(100).toDecimalPlaces(2).toString());
}

export interface Totals {
  subtotal: Decimal;
  discountTotal: Decimal;
  freight: Decimal;
  total: Decimal;
  marginTotal: Decimal | null;
  marginPct: number | null;
}

/**
 * subtotal = sum(qty * quotedPrice); discountTotal = sum(qty * max(list - quoted, 0)) (informational, already
 * reflected in subtotal); total = subtotal + freight. Margin only when every line has a cost.
 */
export function computeTotals(lines: PricedLine[], freight: Decimal = ZERO): Totals {
  let subtotal = ZERO;
  let discount = ZERO;
  let cost = ZERO;
  let allCost = lines.length > 0;
  for (const l of lines) {
    subtotal = subtotal.add(lineTotal(l));
    const d = l.listPrice.sub(l.quotedPrice);
    if (d.gt(0)) discount = discount.add(d.mul(l.qty));
    if (l.cost == null) allCost = false;
    else cost = cost.add(l.cost.mul(l.qty));
  }
  const marginTotal = allCost ? subtotal.sub(cost) : null;
  const marginPct = marginTotal && subtotal.gt(0) ? Number(marginTotal.div(subtotal).mul(100).toDecimalPlaces(2).toString()) : null;
  return { subtotal, discountTotal: discount, freight, total: subtotal.add(freight), marginTotal, marginPct };
}
