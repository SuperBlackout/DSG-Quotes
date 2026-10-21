import { describe, expect, it } from "vitest";
import { formatCents, formatMoney, formatRelative, formatShortDate, fromCents, sumCents, toCents } from "../src/lib/format";
import { parseRoute, routeHref } from "../src/router";

describe("router", () => {
  it("round-trips the extension:// hrefs", () => {
    expect(parseRoute(routeHref({ name: "list" }))).toEqual({ name: "list" });
    expect(parseRoute(routeHref({ name: "notifications" }))).toEqual({ name: "notifications" });
    expect(parseRoute(routeHref({ name: "detail", id: "abc-123" }))).toEqual({ name: "detail", id: "abc-123" });
  });

  it("round-trips ids that need escaping", () => {
    const id = "gid://shopify/Quote/1 2";
    expect(parseRoute(routeHref({ name: "detail", id }))).toEqual({ name: "detail", id });
  });

  it("reads the real page URL, ignoring the extension handle and query", () => {
    const base = "https://shopify.com/12345/account/pages/my-quotes";
    expect(parseRoute(base)).toEqual({ name: "list" });
    expect(parseRoute(`${base}/q/ckx9?foo=1#h`)).toEqual({ name: "detail", id: "ckx9" });
    expect(parseRoute(`${base}/notifications/`)).toEqual({ name: "notifications" });
  });

  it("falls back to the list for junk", () => {
    expect(parseRoute(undefined)).toEqual({ name: "list" });
    expect(parseRoute("https://x.test/account/pages/my-quotes/q")).toEqual({ name: "list" });
    expect(parseRoute("extension://q/%E0%A4%A")).toEqual({ name: "list" });
  });
});

describe("money", () => {
  it("converts to integer cents without float error", () => {
    expect(toCents("0.10")).toBe(10);
    expect(toCents("1234.5")).toBe(123450);
    expect(toCents("19")).toBe(1900);
    expect(sumCents(["0.10", "0.20"])).toBe(30);
    expect(fromCents(123450)).toBe("1234.50");
    expect(fromCents(-5)).toBe("-0.05");
  });

  it("rejects non-decimal input", () => {
    expect(() => toCents("$5")).toThrow();
    expect(() => toCents("1,000.00")).toThrow();
  });

  it("formats as USD", () => {
    expect(formatMoney("3640.00")).toBe("$3,640.00");
    expect(formatMoney("0.5")).toBe("$0.50");
    expect(formatMoney(null)).toBe("");
    expect(formatCents(29600)).toBe("$296.00");
  });
});

describe("dates", () => {
  const now = new Date("2026-10-21T12:00:00.000Z");
  it("formats relative times", () => {
    expect(formatRelative("2026-10-21T11:59:40.000Z", now)).toBe("just now");
    expect(formatRelative("2026-10-21T11:15:00.000Z", now)).toBe("45 min ago");
    expect(formatRelative("2026-10-21T10:00:00.000Z", now)).toBe("2 hours ago");
    expect(formatRelative("2026-10-20T10:00:00.000Z", now)).toBe("yesterday");
    expect(formatRelative("2026-10-18T10:00:00.000Z", now)).toBe("3 days ago");
    expect(formatRelative("2026-09-22T10:00:00.000Z", now, "UTC")).toBe("Sep 22");
  });

  it("drops the year only for the current year", () => {
    expect(formatShortDate("2026-10-18T12:00:00.000Z", now, "UTC")).toBe("Oct 18");
    expect(formatShortDate("2025-10-18T12:00:00.000Z", now, "UTC")).toBe("Oct 18, 2025");
  });
});
