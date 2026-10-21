/**
 * Pure pricing / margin / floor / totals math for the quote editor.
 *
 * Rules
 * - All money is held as integer cents. Strings at the API boundary are "1234.50" (openapi `Money`).
 * - Rounding is half away from zero, done on integers or via a tiny epsilon so 1.005 style
 *   binary-float artefacts do not flip a cent.
 * - Margin % = (price - cost) / price * 100, shown to one decimal (mockup: 25.2%).
 * - A line is "below floor" when its EXACT margin is under the floor % (comparison is done on integers,
 *   never on the rounded display value). Floor % supports two decimals (basis points).
 * - Quote margin excludes freight (mockup 7: (3,814.00 - 2,830.00) / 3,814.00 = 25.8%).
 *
 * The server stays the source of truth (it re-checks the floor on send); this module drives the UI.
 */

export type Cents = number;

export interface PricedLine {
  qty: number;
  /** Dealer / list price per unit in cents. */
  listPriceCents: Cents;
  /** Unit cost in cents, null when unknown (e.g. a freshly picked variant before the first save). */
  costCents: Cents | null;
  /** Quoted unit price in cents. */
  quotedPriceCents: Cents;
  floorApproved?: boolean;
}

/** Round half away from zero to an integer. */
export function roundHalfAwayFromZero(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const sign = n < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(n) * (1 + Number.EPSILON));
}

/** Round to `places` decimals, half away from zero. */
export function roundTo(n: number, places: number): number {
  const f = 10 ** places;
  return roundHalfAwayFromZero(n * f) / f;
}

/**
 * Parse a money string / user input to cents. Accepts "1,234.5", "$749", "749.005" (rounds half up).
 * Returns null for empty or non-numeric input.
 */
export function parseMoney(input: string | number | null | undefined): Cents | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") return Number.isFinite(input) ? roundHalfAwayFromZero(input * 100) : null;
  const cleaned = input.trim().replace(/[$,\s]/g, "");
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
  const negative = cleaned.startsWith("-");
  const [whole = "0", frac = ""] = cleaned.replace("-", "").split(".");
  const wholeCents = Number(whole === "" ? "0" : whole) * 100;
  const padded = (frac + "000").slice(0, 3); // keep 3 digits to round on the third
  const fracThousandths = Number(padded);
  const fracCents = Math.floor(fracThousandths / 10) + (fracThousandths % 10 >= 5 ? 1 : 0);
  const total = wholeCents + fracCents;
  return negative ? -total : total;
}

/** Format cents as the API `Money` string: 123450 -> "1234.50". */
export function toMoneyString(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Display format with thousands separators: 123450 -> "$1,234.50". */
export function formatMoney(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${whole}.${String(abs % 100).padStart(2, "0")}`;
}

export function lineTotalCents(line: Pick<PricedLine, "qty" | "quotedPriceCents">): Cents {
  return Math.trunc(line.qty) * line.quotedPriceCents;
}

/** Margin % to one decimal, or null when cost is unknown or price is not positive. */
export function marginPct(quotedPriceCents: Cents, costCents: Cents | null): number | null {
  if (costCents === null || quotedPriceCents <= 0) return null;
  return roundTo(((quotedPriceCents - costCents) / quotedPriceCents) * 100, 1);
}

/** Floor percentage -> basis points (15 -> 1500, 12.5 -> 1250). */
export function floorToBps(floorPct: number): number {
  return Math.round(floorPct * 100);
}

/**
 * True when the exact margin is strictly below the floor. Unknown cost is never flagged client side
 * (the server decides). Integer math: (price - cost) / price < floorBps / 10000.
 */
export function isBelowFloor(quotedPriceCents: Cents, costCents: Cents | null, floorPct: number): boolean {
  if (costCents === null) return false;
  if (quotedPriceCents <= 0) return true;
  return (quotedPriceCents - costCents) * 10000 < floorToBps(floorPct) * quotedPriceCents;
}

/** Lowest quoted price (cents) that still meets the floor: ceil(cost / (1 - floor)). Null if unknown. */
export function minPriceForFloor(costCents: Cents | null, floorPct: number): Cents | null {
  if (costCents === null) return null;
  const bps = floorToBps(floorPct);
  if (bps >= 10000) return null;
  return Math.ceil((costCents * 10000) / (10000 - bps));
}

export interface FloorViolation<T> {
  index: number;
  line: T;
  marginPct: number | null;
}

/** Lines under the floor that have not been manager-approved. */
export function floorViolations<T extends PricedLine>(lines: readonly T[], floorPct: number): FloorViolation<T>[] {
  const out: FloorViolation<T>[] = [];
  lines.forEach((line, index) => {
    if (line.floorApproved) return;
    if (isBelowFloor(line.quotedPriceCents, line.costCents, floorPct)) {
      out.push({ index, line, marginPct: marginPct(line.quotedPriceCents, line.costCents) });
    }
  });
  return out;
}

export interface QuoteTotals {
  subtotalCents: Cents;
  freightCents: Cents;
  totalCents: Cents;
  /** Sum of qty * cost over lines whose cost is known. */
  costCents: Cents;
  /** Revenue of lines whose cost is known (denominator for margin). */
  costedRevenueCents: Cents;
  marginCents: Cents;
  /** Quote margin % (one decimal), freight excluded. Null if no line has a cost. */
  marginPct: number | null;
  /** True if at least one line has unknown cost, so margin only covers part of the quote. */
  marginPartial: boolean;
  /** Sum of qty * (list - quoted); positive means discounted below dealer price. */
  discountCents: Cents;
}

export function computeTotals(lines: readonly PricedLine[], freightCents: Cents = 0): QuoteTotals {
  let subtotal = 0;
  let cost = 0;
  let costedRevenue = 0;
  let discount = 0;
  let unknown = 0;
  for (const l of lines) {
    const total = lineTotalCents(l);
    subtotal += total;
    discount += Math.trunc(l.qty) * (l.listPriceCents - l.quotedPriceCents);
    if (l.costCents === null) {
      unknown += 1;
    } else {
      cost += Math.trunc(l.qty) * l.costCents;
      costedRevenue += total;
    }
  }
  const margin = costedRevenue - cost;
  return {
    subtotalCents: subtotal,
    freightCents,
    totalCents: subtotal + freightCents,
    costCents: cost,
    costedRevenueCents: costedRevenue,
    marginCents: margin,
    marginPct: costedRevenue > 0 ? roundTo((margin / costedRevenue) * 100, 1) : null,
    marginPartial: unknown > 0,
    discountCents: discount,
  };
}

/** Price after taking `pct` off the list price, rounded to the cent. pct is clamped to 0..100. */
export function priceAfterPercentOff(listPriceCents: Cents, pct: number): Cents {
  const p = Math.min(100, Math.max(0, pct));
  return roundHalfAwayFromZero((listPriceCents * (100 - p)) / 100);
}

/** Apply a % off the list price to every line (the "Apply % off all lines" button). */
export function applyPercentOff<T extends PricedLine>(lines: readonly T[], pct: number): T[] {
  return lines.map((l) => ({ ...l, quotedPriceCents: priceAfterPercentOff(l.listPriceCents, pct) }));
}

/** Parse a user-typed quantity: positive integer, else null. */
export function parseQty(input: string | number): number | null {
  const n = typeof input === "number" ? input : Number(input.trim());
  if (!Number.isInteger(n) || n < 1 || n > 100000) return null;
  return n;
}
