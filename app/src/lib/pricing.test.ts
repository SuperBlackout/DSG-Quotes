import { describe, expect, it } from "vitest";
import {
  applyPercentOff,
  approvalReason,
  formatMoneyIn,
  computeTotals,
  floorToBps,
  floorViolations,
  formatMoney,
  isBelowFloor,
  lineTotalCents,
  marginPct,
  minPriceForFloor,
  parseMoney,
  parseQty,
  priceAfterPercentOff,
  roundHalfAwayFromZero,
  toMoneyString,
  type PricedLine,
} from "./pricing";

const L = (qty: number, list: number, cost: number | null, quoted: number, floorApproved = false): PricedLine => ({
  qty,
  listPriceCents: list,
  costCents: cost,
  quotedPriceCents: quoted,
  floorApproved,
});

/** Mockup 7 (Q-10461 v2 draft). */
const mockup: PricedLine[] = [
  L(2, 79900, 56000, 74900), // PA-935A  25.2%  1,498.00
  L(16, 6200, 4100, 5800), // SPK-650C 29.3%    928.00
  L(8, 8400, 5500, 7900), // SPK-800C 30.4%    632.00
  L(2, 27500, 20500, 25900), // Cat6    20.8%    518.00
  L(6, 3150, 2600, 2800), // VC-70W    7.1%    168.00
  L(1, 7000, 4800, 7000), // shelf    31.4%     70.00
];

describe("rounding and parsing", () => {
  it("rounds half away from zero", () => {
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
    expect(roundHalfAwayFromZero(1.005 * 100)).toBe(101); // 100.49999999999999 in binary floating point
    expect(roundHalfAwayFromZero(Number.NaN)).toBe(0);
  });

  it("parses money input to cents", () => {
    expect(parseMoney("749")).toBe(74900);
    expect(parseMoney("$1,234.5")).toBe(123450);
    expect(parseMoney("749.005")).toBe(74901);
    expect(parseMoney("749.004")).toBe(74900);
    expect(parseMoney("0.1")).toBe(10);
    expect(parseMoney(".99")).toBe(99);
    expect(parseMoney("-12.34")).toBe(-1234);
    expect(parseMoney(19.99)).toBe(1999);
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("abc")).toBeNull();
    expect(parseMoney("1.2.3")).toBeNull();
    expect(parseMoney(null)).toBeNull();
  });

  it("formats money", () => {
    expect(toMoneyString(123450)).toBe("1234.50");
    expect(toMoneyString(5)).toBe("0.05");
    expect(toMoneyString(-1234)).toBe("-12.34");
    expect(toMoneyString(0)).toBe("0.00");
    expect(formatMoney(393400)).toBe("$3,934.00");
    expect(formatMoney(-5)).toBe("-$0.05");
    expect(toMoneyString(parseMoney("1234.50")!)).toBe("1234.50");
  });

  it("parses quantities", () => {
    expect(parseQty("16")).toBe(16);
    expect(parseQty(" 3 ")).toBe(3);
    expect(parseQty("0")).toBeNull();
    expect(parseQty("1.5")).toBeNull();
    expect(parseQty("")).toBeNull();
    expect(parseQty(100001)).toBeNull();
  });
});

describe("line math and margin", () => {
  it("computes line totals", () => {
    expect(lineTotalCents({ qty: 2, quotedPriceCents: 74900 })).toBe(149800);
  });

  it("matches the margins on mockup 7 to one decimal", () => {
    expect(mockup.map((l) => marginPct(l.quotedPriceCents, l.costCents))).toEqual([25.2, 29.3, 30.4, 20.8, 7.1, 31.4]);
  });

  it("returns null margin for unknown cost or non-positive price", () => {
    expect(marginPct(1000, null)).toBeNull();
    expect(marginPct(0, 500)).toBeNull();
  });

  it("allows negative margin when selling below cost", () => {
    expect(marginPct(900, 1000)).toBe(-11.1);
  });
});

describe("price floor", () => {
  it("converts floor percent to basis points", () => {
    expect(floorToBps(15)).toBe(1500);
    expect(floorToBps(12.5)).toBe(1250);
  });

  it("flags only strictly-below-floor lines (exactly at floor passes)", () => {
    // cost 85.00, price 100.00 -> exactly 15.0%
    expect(isBelowFloor(10000, 8500, 15)).toBe(false);
    // one cent lower price -> 14.99...% -> below
    expect(isBelowFloor(9999, 8500, 15)).toBe(true);
  });

  it("compares the exact margin, not the rounded display value", () => {
    // price 10000, cost 8505 -> 14.95% exact; displays as 15.0% (rounded to one decimal) but is below 15
    expect(marginPct(10000, 8505)).toBe(15);
    expect(isBelowFloor(10000, 8505, 15)).toBe(true);
  });

  it("does not flag unknown cost, flags non-positive price", () => {
    expect(isBelowFloor(10000, null, 15)).toBe(false);
    expect(isBelowFloor(0, 100, 15)).toBe(true);
  });

  it("finds the minimum price that meets the floor", () => {
    expect(minPriceForFloor(8500, 15)).toBe(10000);
    expect(minPriceForFloor(2600, 15)).toBe(3059); // 30.588... rounds up
    expect(isBelowFloor(3059, 2600, 15)).toBe(false);
    expect(isBelowFloor(3058, 2600, 15)).toBe(true);
    expect(minPriceForFloor(null, 15)).toBeNull();
    expect(minPriceForFloor(100, 100)).toBeNull();
  });

  it("lists floor violations and skips approved lines", () => {
    const v = floorViolations(mockup, 15);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ index: 4, marginPct: 7.1 });

    const approved = mockup.map((l, i) => (i === 4 ? { ...l, floorApproved: true } : l));
    expect(floorViolations(approved, 15)).toHaveLength(0);
    expect(floorViolations(mockup, 5)).toHaveLength(0);
  });
});

describe("unknown cost", () => {
  const unknown = (approved = false): PricedLine => ({ ...L(1, 5000, null, 5000, approved), costUnknown: true });

  it("always needs approval until a manager approves, with a null margin", () => {
    expect(approvalReason(unknown(), 15)).toBe("unknown_cost");
    expect(approvalReason(unknown(true), 15)).toBeNull();
    const v = floorViolations([L(1, 100, 50, 100), unknown()], 15);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ index: 1, reason: "unknown_cost", marginPct: null });
  });

  it("does not flag an unsaved line (no cost yet, not unknown)", () => {
    expect(approvalReason(L(1, 5000, null, 5000), 15)).toBeNull();
  });

  it("reports the reason for below-floor lines", () => {
    expect(approvalReason(L(1, 10000, 9000, 10000), 15)).toBe("below_floor");
  });

  it("keeps margin partial and counts the flagged lines", () => {
    const t = computeTotals([L(1, 1000, 600, 1000), unknown()], 0);
    expect(t.marginPct).toBe(40);
    expect(t.marginPartial).toBe(true);
    expect(t.unknownCostCount).toBe(1);
    expect(computeTotals([L(1, 1000, null, 1000)]).unknownCostCount).toBe(0);
  });
});

describe("currency formatting", () => {
  it("formats USD and falls back for missing or bad codes", () => {
    expect(formatMoneyIn(123450, "USD")).toBe("$1,234.50");
    expect(formatMoneyIn(123450, undefined)).toBe("$1,234.50");
    expect(formatMoneyIn(123450, "nope")).toBe("$1,234.50");
  });

  it("formats another currency", () => {
    expect(formatMoneyIn(123450, "CAD")).toContain("1,234.50");
  });
});

describe("totals", () => {
  it("matches mockup 7 totals: subtotal 3,814.00 + freight 120.00 = 3,934.00, margin 25.8%", () => {
    const t = computeTotals(mockup, 12000);
    expect(t.subtotalCents).toBe(381400);
    expect(t.freightCents).toBe(12000);
    expect(t.totalCents).toBe(393400);
    expect(t.costCents).toBe(283000);
    expect(t.marginCents).toBe(98400);
    expect(t.marginPct).toBe(25.8);
    expect(t.marginPartial).toBe(false);
  });

  it("excludes freight from margin", () => {
    expect(computeTotals(mockup, 0).marginPct).toBe(computeTotals(mockup, 999900).marginPct);
  });

  it("handles partial and missing costs", () => {
    const t = computeTotals([L(1, 1000, 600, 1000), L(2, 500, null, 500)], 0);
    expect(t.subtotalCents).toBe(2000);
    expect(t.costedRevenueCents).toBe(1000);
    expect(t.marginPct).toBe(40);
    expect(t.marginPartial).toBe(true);
    expect(computeTotals([L(1, 1000, null, 1000)]).marginPct).toBeNull();
  });

  it("handles an empty quote", () => {
    const t = computeTotals([], 5000);
    expect(t).toMatchObject({ subtotalCents: 0, totalCents: 5000, marginPct: null, marginPartial: false });
  });

  it("reports the discount against dealer price", () => {
    // PA-935A 2 x (799 - 749) = 100.00 ; SPK-650C 16 x 4 = 64.00 ; SPK-800C 8 x 5 = 40.00 ; Cat6 2 x 16 = 32.00 ; VC 6 x 3.5 = 21.00
    expect(computeTotals(mockup).discountCents).toBe(10000 + 6400 + 4000 + 3200 + 2100);
  });
});

describe("percent off", () => {
  it("rounds to the cent", () => {
    expect(priceAfterPercentOff(7990, 10)).toBe(7191);
    expect(priceAfterPercentOff(3333, 5)).toBe(3166); // 3166.35
    expect(priceAfterPercentOff(1005, 50)).toBe(503); // 502.5 -> 503 (half away from zero)
  });

  it("clamps the percentage", () => {
    expect(priceAfterPercentOff(1000, -5)).toBe(1000);
    expect(priceAfterPercentOff(1000, 150)).toBe(0);
  });

  it("applies to every line without mutating", () => {
    const out = applyPercentOff(mockup, 10);
    expect(out[0]!.quotedPriceCents).toBe(71910);
    expect(mockup[0]!.quotedPriceCents).toBe(74900);
    expect(out).toHaveLength(mockup.length);
  });
});
