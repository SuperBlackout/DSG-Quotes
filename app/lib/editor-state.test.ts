import { describe, expect, it } from "vitest";
import {
  dateInputToIso,
  diffAgainstVersion,
  formatMoneyWhole,
  isDirty,
  nextVersionNo,
  parseQuoteNumber,
  quoteActions,
  stateFromQuote,
  tabCount,
  toDraftRequest,
  validateEditor,
  waitingLabel,
  waitingSeverity,
  type EditorState,
} from "./editor-state";
import type { StaffQuote, StaffQuoteLine } from "./api-client";

const line = (over: Partial<StaffQuoteLine> = {}): StaffQuoteLine => ({
  id: "l1",
  variantId: "gid://shopify/ProductVariant/1",
  sku: "PA-935A",
  title: "Inter-M PA-935A",
  qty: 2,
  listPrice: "799.00",
  quotedPrice: "749.00",
  cost: "560.00",
  lineTotal: "1498.00",
  marginPct: 25.2,
  position: 0,
  ...over,
});

const quote = (over: Partial<StaffQuote> = {}): StaffQuote =>
  ({
    id: "q1",
    number: 10461,
    title: "Sanctuary speakers",
    status: "CHANGES_REQUESTED",
    waitingOn: "sales",
    customerName: "Dana K.",
    total: "3911.00",
    updatedAt: "2026-10-20T10:00:00Z",
    expiresAt: "2026-11-04T23:59:59.000Z",
    currentVersion: 1,
    workingLines: [line({ id: "b", position: 1, title: "B" }), line({ id: "a", position: 0, title: "A" })],
    workingFreight: "120.00",
    workingRepNote: "Prices held to Nov 4.",
    workingInternalNote: null,
    versions: [{ versionNo: 1, sentAt: "2026-10-19T10:00:00Z", subtotal: "1.00", freight: "0.00", total: "1.00", lines: [] }],
    messages: [],
    ...over,
  }) as StaffQuote;

describe("editor state mapping", () => {
  it("loads working lines in position order with cents", () => {
    const s = stateFromQuote(quote());
    expect(s.lines.map((l) => l.title)).toEqual(["A", "B"]);
    expect(s.lines[0]).toMatchObject({ qty: 2, listPriceCents: 79900, costCents: 56000, quotedPriceCents: 74900 });
    expect(s.freightCents).toBe(12000);
    expect(s.expiresOn).toBe("2026-11-04");
    expect(s.internalNote).toBe("");
  });

  it("keeps unknown cost as null", () => {
    const s = stateFromQuote(quote({ workingLines: [line({ cost: null })] }));
    expect(s.lines[0]!.costCents).toBeNull();
  });

  it("builds a draft-revision request: ids only for saved lines, money strings, nulls for blanks", () => {
    const s = stateFromQuote(quote());
    s.lines.push({
      key: "new-1",
      variantId: "gid://shopify/ProductVariant/9",
      sku: null,
      title: "New",
      imageUrl: null,
      qty: 3,
      listPriceCents: 1000,
      costCents: null,
      quotedPriceCents: 950,
      lineNote: "  ",
    });
    const req = toDraftRequest(s);
    expect(req.lines[0]).toEqual({ id: "a", variantId: "gid://shopify/ProductVariant/1", qty: 2, quotedPrice: "749.00", lineNote: null });
    expect(req.lines[2]).toEqual({ variantId: "gid://shopify/ProductVariant/9", qty: 3, quotedPrice: "9.50", lineNote: null });
    expect(req.freight).toBe("120.00");
    expect(req.expiresAt).toBe("2026-11-04T23:59:59.000Z");
    expect(req.repNote).toBe("Prices held to Nov 4.");
    expect(req.internalNote).toBeNull();
  });

  it("detects dirty state", () => {
    const saved = stateFromQuote(quote());
    expect(isDirty(saved, stateFromQuote(quote()))).toBe(false);
    const changed: EditorState = { ...saved, freightCents: 5000 };
    expect(isDirty(changed, saved)).toBe(true);
  });

  it("validates", () => {
    const s = stateFromQuote(quote());
    expect(validateEditor(s)).toEqual([]);
    expect(validateEditor({ ...s, lines: [] })).toEqual(["Add at least one line item."]);
    expect(validateEditor({ ...s, freightCents: -1 })).toContain("Freight cannot be negative.");
    const bad = { ...s, lines: [{ ...s.lines[0]!, qty: 0 }] };
    expect(validateEditor(bad)[0]).toMatch(/quantity/);
  });

  it("converts the date input", () => {
    expect(dateInputToIso("2026-11-04")).toBe("2026-11-04T23:59:59.000Z");
    expect(dateInputToIso("")).toBeNull();
    expect(dateInputToIso("11/04/2026")).toBeNull();
  });
});

describe("diff against the last sent version", () => {
  it("marks new lines, qty changes and price changes", () => {
    const s = stateFromQuote(
      quote({
        workingLines: [
          line({ id: "a", variantId: "v1", qty: 16 }),
          line({ id: "b", variantId: "v2", qty: 1 }),
          line({ id: "c", variantId: "v3", qty: 1, quotedPrice: "10.00" }),
          line({ id: "d", variantId: "v4", qty: 1 }),
        ],
      }),
    );
    const d = diffAgainstVersion(s.lines, [
      { variantId: "v1", qty: 24, quotedPrice: "749.00" },
      { variantId: "v2", qty: 1, quotedPrice: "749.00" },
      { variantId: "v3", qty: 1, quotedPrice: "12.00" },
    ]);
    expect(d.get("a")).toEqual({ kind: "qty", from: 24 });
    expect(d.has("b")).toBe(false); // same qty and price -> unchanged
    expect(d.get("c")).toEqual({ kind: "price", from: 1200 });
    expect(d.get("d")).toEqual({ kind: "new" });
  });

  it("returns nothing when there is no previous version", () => {
    expect(diffAgainstVersion(stateFromQuote(quote()).lines, undefined).size).toBe(0);
    expect(diffAgainstVersion(stateFromQuote(quote()).lines, []).size).toBe(0);
  });
});

describe("workflow", () => {
  it("computes the next version number", () => {
    expect(nextVersionNo({ currentVersion: 1, versions: [] })).toBe(2);
    expect(nextVersionNo({ currentVersion: undefined, versions: [] })).toBe(1);
    expect(nextVersionNo(quote({ currentVersion: 1, versions: [{ versionNo: 3 } as never] }))).toBe(4);
  });

  it("derives actions from the shared state machine", () => {
    expect(quoteActions("SUBMITTED")).toMatchObject({ canClaim: true, canSend: true, canEdit: true, canReopen: false });
    expect(quoteActions("CHANGES_REQUESTED")).toMatchObject({ canClaim: true, canSend: true });
    expect(quoteActions("IN_REVIEW")).toMatchObject({ canClaim: false, canSend: true });
    expect(quoteActions("ACCEPTED")).toMatchObject({ canReopen: true, canSend: false, canEdit: false });
    expect(quoteActions("ORDERED")).toMatchObject({ canSend: false, canDecline: false, canReopen: false });
  });
});

describe("waiting timer", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  it("formats durations", () => {
    expect(waitingLabel("2026-10-21T11:59:30Z", now)).toBe("<1m");
    expect(waitingLabel("2026-10-21T11:12:00Z", now)).toBe("48m");
    expect(waitingLabel("2026-10-21T08:50:00Z", now)).toBe("3h 10m");
    expect(waitingLabel("2026-10-21T09:00:00Z", now)).toBe("3h");
    expect(waitingLabel("2026-10-19T08:00:00Z", now)).toBe("2d 4h");
    expect(waitingLabel("2026-10-19T12:00:00Z", now)).toBe("2d");
    expect(waitingLabel(null, now)).toBe("");
    expect(waitingLabel("2026-10-22T12:00:00Z", now)).toBe("");
  });

  it("grades severity", () => {
    expect(waitingSeverity("2026-10-21T11:30:00Z", now)).toBe("none");
    expect(waitingSeverity("2026-10-21T10:30:00Z", now)).toBe("warn");
    expect(waitingSeverity("2026-10-21T08:00:00Z", now)).toBe("critical");
    expect(waitingSeverity(undefined, now)).toBe("none");
  });
});

describe("inbox helpers", () => {
  it("maps summary counts to tabs", () => {
    const s = { needsResponse: 5, unassigned: 2, openValue: "64210.00", acceptedThisWeek: 6, expiringSoon: 2 };
    expect(tabCount("needs_response", s)).toBe(5);
    expect(tabCount("unassigned", s)).toBe(2);
    expect(tabCount("expiring", s)).toBe(2);
    expect(tabCount("accepted", s)).toBe(6);
    expect(tabCount("all", s)).toBeUndefined();
    expect(tabCount("waiting_customer", s)).toBeUndefined();
    expect(tabCount("all", null)).toBeUndefined();
  });

  it("formats whole-dollar tiles", () => {
    expect(formatMoneyWhole("64210.00")).toBe("$64,210");
    expect(formatMoneyWhole("0.50")).toBe("$1");
    expect(formatMoneyWhole(undefined)).toBe("$0");
  });

  it("parses quote numbers", () => {
    expect(parseQuoteNumber("Q-10482")).toBe(10482);
    expect(parseQuoteNumber("q10482")).toBe(10482);
    expect(parseQuoteNumber("10482")).toBe(10482);
    expect(parseQuoteNumber("Pure Vision")).toBeNull();
  });
});
