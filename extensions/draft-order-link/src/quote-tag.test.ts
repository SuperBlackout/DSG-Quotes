import { describe, expect, it } from "vitest";
import { displayNumber, quoteAppLink, quoteNumberFromTags } from "./quote-tag";

describe("quoteNumberFromTags", () => {
  it("finds the quote tag among others", () => {
    expect(quoteNumberFromTags(["wholesale", "quote:Q-10482", "rush"])).toBe(10482);
  });
  it("is case and whitespace tolerant", () => {
    expect(quoteNumberFromTags(["QUOTE:q-7"])).toBe(7);
    expect(quoteNumberFromTags([" quote: Q-12 "])).toBe(12);
  });
  it("ignores look-alikes and empty input", () => {
    expect(quoteNumberFromTags(["quote:10482", "quotes:Q-1", "quote:Q-", "xquote:Q-5"])).toBeNull();
    expect(quoteNumberFromTags([])).toBeNull();
    expect(quoteNumberFromTags(undefined)).toBeNull();
  });
  it("builds labels and links", () => {
    expect(displayNumber(10482)).toBe("Q-10482");
    expect(quoteAppLink(10482)).toBe("app:q/10482");
  });
});
