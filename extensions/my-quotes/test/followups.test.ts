// Contract 0.2.0 follow-ups CA-1..CA-13 that are testable without rendering.
import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "../src/api/client";
import { DEFAULT_API_BASE_URL } from "../src/api/instance";
import {
  ASK_NEW_QUOTE_LABEL,
  REVIEW_NEW_VERSION_LABEL,
  isNetworkError,
  isNotPurchasableError,
  isVersionMismatchError,
  versionMismatchMessage,
} from "../src/lib/errors";
import { formatCents, formatMoney } from "../src/lib/format";
import { groupQuotes } from "../src/lib/filters";
import { previousTotalText, quoteSubline, statusBanner, unreadLabel } from "../src/lib/status";
import { quote, summary, version, line } from "./fixtures";

function setup(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond(String(url), init ?? {});
  });
  const api = createApiClient({
    baseUrl: DEFAULT_API_BASE_URL,
    getToken: async () => "tok",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { api, calls };
}

describe("CA-1 api base URL", () => {
  it("defaults to the production origin and calls /c/* on it with a bearer token", async () => {
    expect(DEFAULT_API_BASE_URL).toBe("https://quotes.dsg.direct");
    const { api, calls } = setup(() => new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }));
    await api.listQuotes();
    expect(calls[0]!.url).toBe("https://quotes.dsg.direct/c/quotes");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });
});

describe("CA-2 list row data", () => {
  it("shows the assigned rep in the subline", () => {
    expect(quoteSubline(summary({ status: "IN_REVIEW", assignedRepName: "Marco Reyes" }))).toContain("Rep: Marco Reyes");
    expect(quoteSubline(summary({ status: "IN_REVIEW", assignedRepName: null }))).not.toContain("Rep:");
  });

  it("builds the unread badge text", () => {
    expect(unreadLabel({ unreadCount: 0 })).toBeUndefined();
    expect(unreadLabel({ unreadCount: 1 })).toBe("1 new message");
    expect(unreadLabel({ unreadCount: 3 })).toBe("3 new messages");
  });

  it("shows the old total only when it exists and differs", () => {
    const base = { total: "3640.00", currencyCode: "USD" };
    expect(previousTotalText({ ...base, previousTotal: "3900.00" })).toBe("$3,900.00");
    expect(previousTotalText({ ...base, previousTotal: null })).toBeUndefined();
    expect(previousTotalText({ ...base, previousTotal: "3640.00" })).toBeUndefined();
    expect(previousTotalText({ ...base, previousTotal: "3640" })).toBeUndefined();
    expect(previousTotalText({ ...base, previousTotal: "not money" })).toBeUndefined();
  });
});

describe("CA-4 currency formatting", () => {
  it("formats with the quote's currency code", () => {
    expect(formatMoney("1234.5", "USD")).toBe("$1,234.50");
    expect(formatMoney("1234.5", "CAD")).toBe("CA$1,234.50");
    expect(formatMoney("1234.5", "EUR")).toBe("€1,234.50");
    expect(formatCents(29600, "GBP")).toBe("£296.00");
  });

  it("falls back to USD for a missing or invalid code instead of throwing", () => {
    expect(formatMoney("5", undefined)).toBe("$5.00");
    expect(formatMoney("5", "")).toBe("$5.00");
    expect(formatMoney("5", "NOT-A-CODE")).toBe("$5.00");
  });

  it("is used by the status banner and the group summary", () => {
    const q = quote({
      status: "QUOTE_READY",
      currencyCode: "CAD",
      total: "1100.00",
      currentVersion: 2,
      versions: [
        version({ versionNo: 1, total: "1200.00", lines: [line({ variantId: "a" })] }),
        version({ versionNo: 2, total: "1100.00", lines: [line({ variantId: "a" })] }),
      ],
    });
    expect(statusBanner(q).body).toContain("CA$1,100.00 (was CA$1,200.00)");
    const [g] = groupQuotes([summary({ status: "DRAFT", currencyCode: "CAD", total: "10.00" })], "none");
    expect(g!.summary).toBe("1 quote · CA$10.00");
  });
});

describe("CA-3 canEditHeader", () => {
  it("fixtures mirror the server flag: only DRAFT is header-editable", () => {
    expect(quote({ status: "DRAFT" }).actions.canEditHeader).toBe(true);
    expect(quote({ status: "QUOTE_READY" }).actions.canEditHeader).toBe(false);
  });
});

describe("CA-7 PDF download", () => {
  it("fetches GET /c/quotes/{id}/pdf with the Authorization header and returns the blob and filename", async () => {
    const { api, calls } = setup(
      () =>
        new Response("%PDF-1.7", {
          status: 200,
          headers: { "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="Q-10482-v2.pdf"' },
        }),
    );
    const file = await api.downloadPdf("q1");
    expect(calls[0]!.url).toBe("https://quotes.dsg.direct/c/quotes/q1/pdf");
    expect(calls[0]!.init.method).toBe("GET");
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer tok");
    expect(h.Accept).toBe("application/pdf");
    expect(file.filename).toBe("Q-10482-v2.pdf");
    expect(await file.blob.text()).toBe("%PDF-1.7");
  });

  it("asks for an earlier version with ?version=N", async () => {
    const { api, calls } = setup(() => new Response("x", { status: 200 }));
    const file = await api.downloadPdf("q1", 1);
    expect(calls[0]!.url).toBe("https://quotes.dsg.direct/c/quotes/q1/pdf?version=1");
    expect(file.filename).toBe("quote.pdf");
  });

  it("maps 404 (no version sent yet) to an ApiError", async () => {
    const { api } = setup(
      () => new Response(JSON.stringify({ code: "NOT_FOUND", message: "No PDF yet" }), { status: 404 }),
    );
    const err = await api.downloadPdf("q1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, code: "NOT_FOUND" });
  });
});

describe("CA-8 / CA-9 purchase and accept errors", () => {
  it("classifies the two 409s and offers the right next step", () => {
    const notPurchasable = new ApiError(409, "NOT_PURCHASABLE", "expired");
    const stale = new ApiError(409, "VERSION_MISMATCH", "stale", { currentVersion: 3 });
    expect(isNotPurchasableError(notPurchasable)).toBe(true);
    expect(isVersionMismatchError(notPurchasable)).toBe(false);
    expect(isVersionMismatchError(stale)).toBe(true);
    expect(isNotPurchasableError(undefined)).toBe(false);
    expect(ASK_NEW_QUOTE_LABEL).toBe("Ask for a new quote");
    expect(REVIEW_NEW_VERSION_LABEL).toBe("Review the new version");
  });

  it("names the new version from details.currentVersion when present", () => {
    expect(versionMismatchMessage({ details: { currentVersion: 3 } })).toContain("version 3");
    expect(versionMismatchMessage({ details: undefined })).toContain("a newer version");
  });

  it("surfaces details.currentVersion from the API on the thrown error", async () => {
    const { api } = setup(
      () =>
        new Response(
          JSON.stringify({ code: "VERSION_MISMATCH", message: "A newer version exists", details: { currentVersion: 3 } }),
          { status: 409 },
        ),
    );
    const err = await api.acceptQuote("q1", 2).catch((e: unknown) => e);
    expect(isVersionMismatchError(err as ApiError)).toBe(true);
    expect((err as ApiError).details).toEqual({ currentVersion: 3 });
  });

  it("an accepted quote that cannot be bought still offers 'Ask for a new quote' in its banner", () => {
    const q = quote({ status: "ACCEPTED", actions: { ...quote({ status: "ACCEPTED" }).actions, canBuy: false } });
    expect(statusBanner(q).actions.map((a) => a.label)).toEqual([ASK_NEW_QUOTE_LABEL]);
  });

  it("duplicate hits POST /c/quotes/{id}/duplicate", async () => {
    const { api, calls } = setup(() => new Response(JSON.stringify(quote({ status: "DRAFT" })), { status: 201 }));
    await api.duplicateQuote("q1");
    expect(calls[0]!.url).toBe("https://quotes.dsg.direct/c/quotes/q1/duplicate");
    expect(calls[0]!.init.method).toBe("POST");
  });
});

describe("CA-10 network / CORS failures", () => {
  it("turns a rejected fetch (CORS from a null origin looks like this) into a NETWORK ApiError", async () => {
    const api = createApiClient({
      baseUrl: DEFAULT_API_BASE_URL,
      getToken: async () => "tok",
      fetch: (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
    });
    const err = await api.listQuotes().catch((e: unknown) => e);
    expect(isNetworkError(err as ApiError)).toBe(true);
    const pdfErr = await api.downloadPdf("q1").catch((e: unknown) => e);
    expect(isNetworkError(pdfErr as ApiError)).toBe(true);
  });
});

describe("CA-11 quote-level watchers stay emails", () => {
  it("PATCH body is passed through untouched (strings only)", async () => {
    const { api, calls } = setup(() => new Response(JSON.stringify(quote({ status: "DRAFT" })), { status: 200 }));
    await api.updateQuote("q1", { watchers: ["sam@example.com"] });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ watchers: ["sam@example.com"] });
  });
});

describe("staff-field guard still applies to every response", () => {
  it("refuses a quote that leaks cost or internalNote with CONTRACT_VIOLATION", async () => {
    const leaky = { ...quote({ status: "DRAFT" }), lines: [{ ...line({ variantId: "a" }), cost: "50.00" }] };
    const { api } = setup(() => new Response(JSON.stringify(leaky), { status: 200 }));
    const err = await api.getQuote("q1").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "CONTRACT_VIOLATION", status: 502 });
  });

  it("also refuses the new summary fields' neighbours (previousTotal is fine, margin is not)", async () => {
    const ok = { items: [summary({ status: "QUOTE_READY", previousTotal: "10.00", unreadCount: 2 })], nextCursor: null };
    const good = setup(() => new Response(JSON.stringify(ok), { status: 200 }));
    await expect(good.api.listQuotes()).resolves.toBeDefined();
    const bad = setup(
      () => new Response(JSON.stringify({ ...ok, items: [{ ...ok.items[0], marginPct: 12 }] }), { status: 200 }),
    );
    await expect(bad.api.listQuotes()).rejects.toMatchObject({ code: "CONTRACT_VIOLATION" });
  });
});
