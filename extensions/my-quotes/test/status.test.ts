import { describe, expect, it } from "vitest";
import type { QuoteStatus } from "../src/api/types";
import { rowActions, statusBadgeTone, statusBanner, statusLabel } from "../src/lib/status";
import { ACTIONS_BY_STATUS, NO_ACTIONS, line, quote, summary, version } from "./fixtures";

const ids = (s: QuoteStatus, over = {}) => rowActions(summary({ status: s, ...over })).map((a) => a.id);

describe("rowActions: status -> actions (screen 3)", () => {
  it("QUOTE_READY -> Review quote", () => {
    expect(ids("QUOTE_READY")).toEqual(["review"]);
    expect(rowActions(summary({ status: "QUOTE_READY" }))[0]).toMatchObject({ label: "Review quote", variant: "primary" });
  });

  it("ACCEPTED and purchasable -> Buy now", () => {
    expect(ids("ACCEPTED")).toEqual(["buy"]);
  });

  it("ACCEPTED but not purchasable (expired) offers no Buy now, only View", () => {
    expect(ids("ACCEPTED", { actions: { ...ACTIONS_BY_STATUS.ACCEPTED, canBuy: false } })).toEqual(["view"]);
  });

  it("DRAFT -> Submit then Delete draft", () => {
    expect(ids("DRAFT")).toEqual(["submit", "delete"]);
    expect(rowActions(summary({ status: "DRAFT" }))[1]).toMatchObject({ label: "Delete draft", tone: "critical" });
  });

  it("DRAFT with an API that forbids delete shows only Submit", () => {
    expect(ids("DRAFT", { actions: { ...ACTIONS_BY_STATUS.DRAFT, canDelete: false } })).toEqual(["submit"]);
  });

  it("SUBMITTED, IN_REVIEW and CHANGES_REQUESTED -> View", () => {
    expect(ids("SUBMITTED")).toEqual(["view"]);
    expect(ids("IN_REVIEW")).toEqual(["view"]);
    expect(ids("CHANGES_REQUESTED")).toEqual(["view"]);
  });

  it("ORDERED -> View order (needs an orderId)", () => {
    expect(ids("ORDERED", { orderId: "gid://shopify/Order/1" })).toEqual(["view-order"]);
    expect(ids("ORDERED", { orderId: null })).toEqual(["view"]);
  });

  it("EXPIRED and DECLINED -> Duplicate", () => {
    expect(ids("EXPIRED")).toEqual(["duplicate"]);
    expect(ids("DECLINED")).toEqual(["duplicate"]);
  });

  it("never invents an action the API did not allow", () => {
    // Even a QUOTE_READY quote shows no Review/Buy/Submit when every flag is false.
    expect(ids("QUOTE_READY", { actions: NO_ACTIONS })).toEqual(["view"]);
    expect(ids("DRAFT", { actions: NO_ACTIONS })).toEqual(["view"]);
  });
});

describe("statusLabel / statusBadgeTone", () => {
  it("shows the version only on a ready quote", () => {
    expect(statusLabel({ status: "QUOTE_READY", currentVersion: 2 })).toBe("Quote ready · v2");
    expect(statusLabel({ status: "ACCEPTED", currentVersion: 2 })).toBe("Accepted");
    expect(statusLabel({ status: "CHANGES_REQUESTED", currentVersion: 1 })).toBe("Changes requested");
  });

  it("only uses badge tones the customer-account component supports", () => {
    const all: QuoteStatus[] = Object.keys(ACTIONS_BY_STATUS) as QuoteStatus[];
    for (const s of all) expect(["auto", "neutral", "critical"]).toContain(statusBadgeTone(s));
    expect(statusBadgeTone("QUOTE_READY")).toBe("auto");
    expect(statusBadgeTone("ORDERED")).toBe("neutral");
  });
});

describe("statusBanner (screen 4)", () => {
  const now = new Date("2026-10-21T12:00:00.000Z");
  const v1 = version({ versionNo: 1, total: "3912.00", sentAt: "2026-10-18T15:00:00.000Z", lines: [line({ variantId: "a" })] });
  const v2 = version({ versionNo: 2, total: "3640.00", sentAt: "2026-10-21T10:00:00.000Z", lines: [line({ variantId: "a" })] });

  it("QUOTE_READY: rep, revision, new vs old total, hold date, Request changes + Accept", () => {
    const b = statusBanner(
      quote({ status: "QUOTE_READY", currentVersion: 2, total: "3640.00", assignedRepName: "Marco Reyes", versions: [v1, v2] }),
      now,
    );
    expect(b.tone).toBe("success");
    expect(b.heading).toBe("Marco Reyes sent revision v2 · 2 hours ago");
    expect(b.body).toContain("New total $3,640.00 (was $3,912.00).");
    expect(b.body).toContain("Prices are held until Nov 4, 2026.");
    expect(b.actions.map((a) => a.id)).toEqual(["request-changes", "accept"]);
    expect(b.actions[1]).toMatchObject({ label: "Accept quote", variant: "primary" });
  });

  it("QUOTE_READY on the first version says 'your quote' and has no 'was'", () => {
    const b = statusBanner(quote({ status: "QUOTE_READY", currentVersion: 1, versions: [v1], total: "3912.00" }), now);
    expect(b.heading).toMatch(/sent your quote/);
    expect(b.body).not.toContain("was");
  });

  it("hides Accept / Request changes when the API did not allow them", () => {
    const b = statusBanner(
      quote({ status: "QUOTE_READY", currentVersion: 2, versions: [v1, v2], actions: { ...NO_ACTIONS, canAccept: false } }),
      now,
    );
    expect(b.actions).toEqual([]);
  });

  it("ACCEPTED + canBuy -> Buy now (+ reopen)", () => {
    const b = statusBanner(quote({ status: "ACCEPTED" }), now);
    expect(b.actions.map((a) => a.id)).toEqual(["reopen", "buy"]);
  });

  it("ACCEPTED but not purchasable -> offer 'Ask for a new quote'", () => {
    const b = statusBanner(quote({ status: "ACCEPTED", actions: NO_ACTIONS }), now);
    expect(b.tone).toBe("warning");
    expect(b.actions).toEqual([{ id: "ask-new-quote", label: "Ask for a new quote", variant: "primary" }]);
  });

  it("EXPIRED -> 'Ask for a new quote'", () => {
    expect(statusBanner(quote({ status: "EXPIRED" }), now).actions.map((a) => a.id)).toEqual(["ask-new-quote"]);
  });

  it("DRAFT -> Submit; SUBMITTED -> Withdraw", () => {
    expect(statusBanner(quote({ status: "DRAFT" }), now).actions.map((a) => a.id)).toEqual(["submit"]);
    expect(statusBanner(quote({ status: "SUBMITTED" }), now).actions.map((a) => a.id)).toEqual(["withdraw"]);
  });

  it("waiting states carry no actions", () => {
    for (const s of ["IN_REVIEW", "CHANGES_REQUESTED", "DECLINED", "ARCHIVED"] as const) {
      expect(statusBanner(quote({ status: s }), now).actions).toEqual([]);
    }
  });

  it("ORDERED -> View order only with an orderId", () => {
    expect(statusBanner(quote({ status: "ORDERED", orderId: "o1" }), now).actions.map((a) => a.id)).toEqual(["view-order"]);
    expect(statusBanner(quote({ status: "ORDERED", orderId: null }), now).actions).toEqual([]);
  });
});
