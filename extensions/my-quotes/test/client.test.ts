import { describe, expect, it, vi } from "vitest";
import { ApiError, STAFF_ONLY_KEYS, assertCustomerSafe, createApiClient } from "../src/api/client";
import { prefs, quote, summary } from "./fixtures";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setup(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond(String(url), init ?? {});
  });
  let n = 0;
  const api = createApiClient({
    baseUrl: "https://quotes.example.com/",
    getToken: async () => `tok-${++n}`,
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { api, calls };
}

describe("api client", () => {
  it("sends a fresh bearer token on every request and trims the base URL", async () => {
    const { api, calls } = setup(() => jsonResponse({ items: [], nextCursor: null }));
    await api.listQuotes();
    await api.listQuotes();
    expect(calls[0]!.url).toBe("https://quotes.example.com/c/quotes");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok-2");
  });

  it("serialises list filters and skips empty ones", async () => {
    const { api, calls } = setup(() => jsonResponse({ items: [summary({ status: "DRAFT" })], nextCursor: null }));
    await api.listQuotes({ status: "QUOTE_READY", q: "lake view", jobId: "", limit: 50 });
    expect(calls[0]!.url).toBe("https://quotes.example.com/c/quotes?status=QUOTE_READY&q=lake+view&limit=50");
  });

  it("encodes ids and posts JSON bodies", async () => {
    const { api, calls } = setup(() => jsonResponse(quote({ status: "CHANGES_REQUESTED" })));
    await api.requestChanges("gid://shopify/x/1", "Please lower the amp price");
    const c = calls[0]!;
    expect(c.url).toBe("https://quotes.example.com/c/quotes/gid%3A%2F%2Fshopify%2Fx%2F1/request-changes");
    expect(c.init.method).toBe("POST");
    expect(JSON.parse(String(c.init.body))).toEqual({ message: "Please lower the amp price" });
    expect((c.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("accept passes the version the customer saw", async () => {
    const { api, calls } = setup(() => jsonResponse(quote({ status: "ACCEPTED" })));
    await api.acceptQuote("q1", 2);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ versionNo: 2 });
  });

  it("checkout returns the invoice URL", async () => {
    const { api, calls } = setup(() => jsonResponse({ invoiceUrl: "https://dsg.direct/invoices/abc", draftOrderId: "d1" }));
    const res = await api.checkout("q1");
    expect(calls[0]!.url).toMatch(/\/c\/quotes\/q1\/checkout$/);
    expect(res.invoiceUrl).toBe("https://dsg.direct/invoices/abc");
  });

  it("maps API error bodies to ApiError with code, status and details", async () => {
    const { api } = setup(() =>
      jsonResponse({ code: "NOT_PURCHASABLE", message: "Quote expired on Oct 6", details: { expiresAt: "x" } }, 409),
    );
    const err = await api.checkout("q1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: "NOT_PURCHASABLE", message: "Quote expired on Oct 6" });
    expect((err as ApiError).details).toEqual({ expiresAt: "x" });
  });

  it("falls back to status-based codes for non-JSON errors", async () => {
    const { api } = setup(() => new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(api.getQuote("q1")).rejects.toMatchObject({ status: 502, code: "INTERNAL" });
    const { api: api401 } = setup(() => new Response("", { status: 401 }));
    await expect(api401.getQuote("q1")).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
  });

  it("wraps network failures", async () => {
    const { api } = setup(() => {
      throw new TypeError("Failed to fetch");
    });
    await expect(api.getQuote("q1")).rejects.toMatchObject({ status: 0, code: "NETWORK" });
  });

  it("PUTs notification prefs", async () => {
    const { api, calls } = setup(() => jsonResponse(prefs()));
    await api.putNotificationPrefs(prefs());
    expect(calls[0]!.init.method).toBe("PUT");
    expect(calls[0]!.url).toBe("https://quotes.example.com/c/notification-prefs");
  });

  it("uploads attachments: signed URL, then raw PUT without the bearer token", async () => {
    const { api, calls } = setup((url) => {
      if (url.endsWith("/attachments/upload-url")) {
        return jsonResponse({
          uploadUrl: "https://bucket.example.com/put?sig=1",
          fileUrl: "https://bucket.example.com/files/a.pdf",
          expiresAt: "2026-10-21T12:00:00.000Z",
        });
      }
      return new Response("", { status: 200 });
    });
    const file = new File(["hello"], "layout.pdf", { type: "application/pdf" });
    const att = await api.uploadAttachment("q1", file);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ name: "layout.pdf", size: 5, mime: "application/pdf" });
    expect(calls[1]!.url).toBe("https://bucket.example.com/put?sig=1");
    expect(calls[1]!.init.method).toBe("PUT");
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(att).toEqual({
      url: "https://bucket.example.com/files/a.pdf",
      name: "layout.pdf",
      size: 5,
      mime: "application/pdf",
    });
  });

  it("surfaces failed uploads", async () => {
    const { api } = setup((url) =>
      url.endsWith("/upload-url")
        ? jsonResponse({ uploadUrl: "https://b/put", fileUrl: "https://b/f", expiresAt: "2026-10-21T12:00:00.000Z" })
        : new Response("", { status: 403 }),
    );
    await expect(api.uploadAttachment("q1", new File(["x"], "a.png", { type: "image/png" }))).rejects.toMatchObject({
      code: "UPLOAD_FAILED",
    });
  });
});

describe("staff-field guard (CLAUDE.md rules 4 and 5)", () => {
  it("accepts a clean customer quote", () => {
    expect(() => assertCustomerSafe(quote({ status: "QUOTE_READY" }))).not.toThrow();
  });

  it.each([...STAFF_ONLY_KEYS])("rejects a response containing %s at depth", (key) => {
    const leaked = { items: [{ lines: [{ id: "l1", [key]: "12.00" }] }] };
    expect(() => assertCustomerSafe(leaked)).toThrowError(/staff-only field/);
  });

  it("the client refuses a leaked response instead of returning it", async () => {
    const { api } = setup(() => jsonResponse({ ...quote({ status: "QUOTE_READY" }), internalNote: "margin is 31%" }));
    await expect(api.getQuote("q1")).rejects.toMatchObject({ code: "CONTRACT_VIOLATION" });
  });
});
