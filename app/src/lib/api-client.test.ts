import { describe, expect, it } from "vitest";
import { ApiError, buildQuery, createStaffClient } from "./api-client";

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body === undefined || status === 204 ? null : JSON.stringify(body), { status });
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

describe("contract 0.2.0 endpoints", () => {
  const call = async (fn: (c: ReturnType<typeof createStaffClient>) => Promise<unknown>, status = 200, body: unknown = {}) => {
    const { f, calls } = fakeFetch(status, body);
    await fn(createStaffClient({ getToken: async () => "t", fetch: f }));
    return calls[0]!;
  };

  it("GET /s/me, /s/staff, /s/teams, /s/settings, /s/saved-replies", async () => {
    expect((await call((c) => c.me())).url).toBe("/api/s/me");
    expect((await call((c) => c.listStaff())).url).toBe("/api/s/staff");
    expect((await call((c) => c.listStaff(true))).url).toBe("/api/s/staff?active=true");
    expect((await call((c) => c.listTeams())).url).toBe("/api/s/teams");
    expect((await call((c) => c.getSettings())).url).toBe("/api/s/settings");
    expect((await call((c) => c.listSavedReplies())).url).toBe("/api/s/saved-replies");
  });

  it("writes staff, teams, settings and saved replies with the contract bodies", async () => {
    const staff = await call((c) => c.updateStaff("s/1", { role: "manager", teamIds: ["t1"], priceFloorPct: null, active: true }));
    expect([staff.url, staff.init.method]).toEqual(["/api/s/staff/s%2F1", "PUT"]);
    expect(JSON.parse(staff.init.body as string)).toEqual({ role: "manager", teamIds: ["t1"], priceFloorPct: null, active: true });

    const create = await call((c) => c.createTeam({ name: "Install", memberIds: ["s1"] }), 201);
    expect([create.url, create.init.method]).toEqual(["/api/s/teams", "POST"]);
    const rename = await call((c) => c.updateTeam("t1", { name: "Sales" }));
    expect([rename.url, rename.init.method]).toEqual(["/api/s/teams/t1", "PUT"]);
    const del = await call((c) => c.deleteTeam("t1"), 204, undefined);
    expect([del.url, del.init.method]).toEqual(["/api/s/teams/t1", "DELETE"]);

    const settings = await call((c) =>
      c.putSettings({ defaultPriceFloorPct: 15, routing: { defaultTeamId: null, autoAssignByCompany: false, rules: [] } }),
    );
    expect([settings.url, settings.init.method]).toEqual(["/api/s/settings", "PUT"]);

    const replies = await call((c) => c.putSavedReplies([{ title: "Hi", body: "Hello", shared: false }]));
    expect([replies.url, replies.init.method]).toEqual(["/api/s/saved-replies", "PUT"]);
    expect(JSON.parse(replies.init.body as string)).toEqual({ items: [{ title: "Hi", body: "Hello", shared: false }] });
  });

  it("request-floor-approval, upload-url and customer search", async () => {
    const r = await call((c) => c.requestFloorApproval("q1", { lineIds: ["l1"], note: "please" }));
    expect([r.url, r.init.method]).toEqual(["/api/s/quotes/q1/request-floor-approval", "POST"]);
    expect(JSON.parse(r.init.body as string)).toEqual({ lineIds: ["l1"], note: "please" });

    const u = await call((c) => c.createAttachmentUpload("q1", { name: "a.pdf", size: 10, mime: "application/pdf" }));
    expect([u.url, u.init.method]).toEqual(["/api/s/quotes/q1/attachments/upload-url", "POST"]);

    const s = await call((c) => c.searchCustomers("  Pure Vision ", 5), 200, { items: [] });
    expect(s.url).toBe("/api/s/customers?q=Pure+Vision&limit=5");
  });
});
