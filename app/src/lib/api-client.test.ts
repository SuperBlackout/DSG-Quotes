import { describe, expect, it } from "vitest";
import { ApiError, buildQuery, createStaffClient } from "./api-client";
import { safe, validateFloorPct } from "./proposed-api";

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body === undefined ? "" : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("buildQuery", () => {
  it("skips empty values and encodes", () => {
    expect(buildQuery({ tab: "all", q: "Q 1&2", rep: "", team: undefined })).toBe("?tab=all&q=Q+1%262");
    expect(buildQuery({})).toBe("");
  });
});

describe("staff client", () => {
  it("sends the bearer token and query", async () => {
    const { f, calls } = fakeFetch(200, { items: [], nextCursor: null });
    const c = createStaffClient({ getToken: async () => "tok", fetch: f });
    await c.listQuotes({ tab: "needs_response", rep: "me" });
    expect(calls[0]!.url).toBe("/api/s/quotes?tab=needs_response&rep=me");
    expect((calls[0]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("PUTs JSON for draft-revision and encodes ids", async () => {
    const { f, calls } = fakeFetch(200, {});
    const c = createStaffClient({ baseUrl: "/api/", getToken: async () => "t", fetch: f });
    await c.saveDraft("a/b", { lines: [], freight: "0.00" });
    expect(calls[0]!.url).toBe("/api/s/quotes/a%2Fb/draft-revision");
    expect(calls[0]!.init.method).toBe("PUT");
    expect(calls[0]!.init.body).toBe('{"lines":[],"freight":"0.00"}');
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("posts internal notes with internal true", async () => {
    const { f, calls } = fakeFetch(201, { id: "m" });
    const c = createStaffClient({ getToken: async () => "t", fetch: f });
    await c.postMessage("q1", { body: "hi", internal: true });
    expect(calls[0]!.url).toBe("/api/s/quotes/q1/messages");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ body: "hi", internal: true });
  });

  it("throws ApiError with floor line ids on 422", async () => {
    const { f } = fakeFetch(422, { code: "FLOOR_APPROVAL_REQUIRED", message: "Needs approval", details: { lineIds: ["l5"] } });
    const c = createStaffClient({ getToken: async () => "t", fetch: f });
    const err = await c.send("q1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).floorLineIds).toEqual(["l5"]);
  });

  it("falls back to a generic error for non-JSON failures", async () => {
    const f = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as unknown as typeof fetch;
    const c = createStaffClient({ getToken: async () => "t", fetch: f });
    const err = (await c.summary().catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("INTERNAL");
    expect(err.status).toBe(502);
    expect(err.floorLineIds).toEqual([]);
  });
});

describe("proposed endpoints helpers", () => {
  it("safe() returns the fallback on failure", async () => {
    const r = await safe(async () => Promise.reject(new Error("404")), 5);
    expect(r).toEqual({ data: 5, available: false });
    expect(await safe(async () => 1, 5)).toEqual({ data: 1, available: true });
  });

  it("validates the floor percentage", () => {
    expect(validateFloorPct("15")).toEqual({ ok: true, value: 15 });
    expect(validateFloorPct(" 12.505 ")).toEqual({ ok: true, value: 12.51 });
    expect(validateFloorPct("")).toMatchObject({ ok: false });
    expect(validateFloorPct("abc")).toMatchObject({ ok: false });
    expect(validateFloorPct("100")).toMatchObject({ ok: false });
    expect(validateFloorPct("-1")).toMatchObject({ ok: false });
  });
});
