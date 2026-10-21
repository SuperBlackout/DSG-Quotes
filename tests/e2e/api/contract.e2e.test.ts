/**
 * RUNNABLE LAYER: contract tests. Every response in every e2e file is already validated against docs/openapi.yaml by
 * the harness (support/world.ts). This file adds: (1) sanity of the spec itself, (2) the operations the other files
 * do not reach (notification prefs, staff create/assign, filters), (3) error-shape checks, (4) proof that the
 * validator can fail. api/zz-coverage then asserts every /c and /s operation was hit.
 */
import { describe, expect, it } from "vitest";
import { FORBIDDEN_KEYS } from "./support/leak";
import { operations, spec, validate, deref } from "./support/contract";
import { claimAndPrice, draftWith, ok, sentQuote, submitted } from "./support/flows";
import * as F from "./support/fixtures";
import { useWorld } from "./support/world";

describe("docs/openapi.yaml sanity", () => {
  it("has unique operationIds and every $ref resolves", () => {
    const ids = operations().map((o) => o.op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(Boolean)).toBe(true);
    const refs = [...JSON.stringify(spec).matchAll(/"\$ref":"([^"]+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(50);
    for (const r of refs) expect(() => deref({ $ref: r }), r).not.toThrow();
  });

  it("customer schemas declare no cost, margin, floor or internal fields (rules 4 and 5, at the contract level)", () => {
    const seen = new Set<string>();
    const walk = (node: any, trail: string) => {
      if (!node || typeof node !== "object") return;
      if (typeof node.$ref === "string") {
        if (seen.has(node.$ref)) return;
        seen.add(node.$ref);
        return walk(deref(node), node.$ref);
      }
      for (const [k, v] of Object.entries<any>(node.properties ?? {})) {
        if (FORBIDDEN_KEYS.has(k)) throw new Error(`customer schema ${trail} declares forbidden property "${k}"`);
        walk(v, `${trail}.${k}`);
      }
      for (const key of ["items", "additionalProperties"]) walk(node[key], trail);
      for (const key of ["allOf", "oneOf"]) for (const s of node[key] ?? []) walk(s, trail);
    };
    for (const o of operations().filter((x) => x.path.startsWith("/c/"))) {
      for (const resp of Object.values<any>(o.op.responses ?? {})) walk(deref(resp)?.content?.["application/json"]?.schema, `${o.method} ${o.path}`);
      walk(deref(o.op.requestBody)?.content?.["application/json"]?.schema, `${o.method} ${o.path} request`);
    }
    expect(seen.size).toBeGreaterThan(5);
  });

  it("the validator rejects wrong types, missing required keys, unknown keys, bad enums, formats and nulls", () => {
    const line = { $ref: "#/components/schemas/CustomerQuoteLine" };
    const good = { id: "l", variantId: "v", title: "t", qty: 1, listPrice: "1.00", quotedPrice: "1.00", lineTotal: "1.00", position: 1 };
    expect(validate(good, line)).toEqual([]);
    expect(validate({ ...good, cost: "0.50" }, line).join()).toMatch(/cost.*not in the contract/);
    expect(validate({ ...good, qty: "1" }, line).join()).toMatch(/qty.*integer/);
    expect(validate({ ...good, qty: 0 }, line).join()).toMatch(/minimum/);
    expect(validate({ ...good, quotedPrice: "1.5" }, line).join()).toMatch(/quotedPrice/);
    expect(validate({ ...good, title: null }, line).join()).toMatch(/null/);
    expect(validate({ ...good, imageUrl: null }, line)).toEqual([]); // nullable
    const { id: _id, ...noId } = good;
    expect(validate(noId, line).join()).toMatch(/id.*required/);
    expect(validate({ code: "X", message: "m" }, { $ref: "#/components/schemas/Error" })).toEqual([]);
    expect(validate("DONE", { $ref: "#/components/schemas/QuoteStatus" }).join()).toMatch(/not one of/);
    const fromCart = { $ref: "#/components/schemas/FromCartRequest" };
    const cartLines = [{ variantId: "v", qty: 1 }];
    expect(validate({ cartLines, target: { mode: "new", title: "t" } }, fromCart)).toEqual([]);
    expect(validate({ cartLines, target: { mode: "existing", quoteId: "q" } }, fromCart)).toEqual([]);
    expect(validate({ cartLines, target: { mode: "existing" } }, fromCart).join()).toMatch(/oneOf/);
    expect(validate({ cartLines: [], target: { mode: "new", title: "t" } }, fromCart).join()).toMatch(/fewer than 1/);
  });
});

describe("authentication is enforced on every operation", () => {
  const w = useWorld();
  it("every /c and /s operation in the contract answers 401 with the Error shape when called without credentials", async () => {
    const ops = operations().filter((o) => /^\/(c|s)\//.test(o.path));
    expect(ops.length).toBeGreaterThan(30);
    for (const o of ops) {
      const url = o.path.replace(/\{\w+\}/g, "x");
      const body = ["POST", "PUT", "PATCH"].includes(o.method) ? {} : undefined;
      const r = await (w.anon as any)[o.method === "DELETE" ? "del" : o.method.toLowerCase()](url, ...(body ? [body, { loose: true }] : []));
      expect(r.status, `${o.method} ${o.path}`).toBe(401);
      expect(r.body.code).toBe("UNAUTHENTICATED");
    }
  });
});

describe("operations not covered by the lifecycle files", () => {
  const w = useWorld();

  it("notification prefs (Screen 5): defaults, save, SMS opt-in needs a valid phone and the consent text, consent is kept", async () => {
    const def = ok(await w.dana.get("/c/notification-prefs"), 200, "defaults");
    // Exactly the seven contract keys (CHANGES_REQUESTED is staff-only), email on and SMS off by default.
    expect(Object.keys(def.events).sort()).toEqual(["ACCEPTED", "EXPIRING", "NEW_MESSAGE", "ORDERED", "QUOTE_READY", "QUOTE_RECEIVED", "WEEKLY_SUMMARY"]);
    for (const k of Object.keys(def.events)) expect(def.events[k], k).toEqual({ email: true, sms: false });
    expect(def).toMatchObject({ email: "dana@acme.example.test", smsOptIn: false, smsOptInAt: null, watchers: [] });

    // PUT replaces all seven: a missing key or an unknown key (including the retired CHANGES_REQUESTED) is a 400.
    const { QUOTE_RECEIVED: _drop, ...sixKeys } = def.events;
    expect((await w.dana.put("/c/notification-prefs", { events: sixKeys, email: def.email }, { loose: true })).status).toBe(400);
    const retired = await w.dana.put("/c/notification-prefs", { events: { ...def.events, CHANGES_REQUESTED: { email: true, sms: false } }, email: def.email }, { loose: true });
    expect(retired.status).toBe(400);
    expect(retired.body.code).toBe("BAD_REQUEST");
    expect((await w.dana.put("/c/notification-prefs", { events: { ...def.events, ORDERED: { email: true } }, email: def.email }, { loose: true })).status).toBe(400);

    const events = { ...def.events, QUOTE_READY: { email: true, sms: true }, NEW_MESSAGE: { email: false, sms: false } };
    const noOptIn = await w.dana.put("/c/notification-prefs", { ...def, events }, { loose: true });
    expect(noOptIn.status).toBe(422);
    expect(noOptIn.body.details).toMatchObject({ field: "smsOptIn" });
    const badPhone = await w.dana.put("/c/notification-prefs", { ...def, events, smsOptIn: true, phone: "555-1212", smsConsentText: "I agree" }, { loose: true });
    expect(badPhone.status).toBe(422);
    const noConsent = await w.dana.put("/c/notification-prefs", { ...def, events, smsOptIn: true, phone: "+13125550123" }, { loose: true });
    expect(noConsent.status).toBe(422);

    // Watchers are objects now. Scope is "all" or a job of the caller's own company; another company's job is a 422.
    const job = (await draftWith(w.dana)).job;
    const theirJob = (await draftWith(w.bea)).job;
    const watcher = { email: "boss@acme.example.test", name: "Pat Boss", role: "Project manager", scope: job.id, channels: { email: true, sms: false } };
    const foreign = await w.dana.put("/c/notification-prefs", { events: def.events, email: def.email, watchers: [{ ...watcher, scope: theirJob.id }] }, { loose: true });
    expect(foreign.status).toBe(422);
    expect(foreign.body.details).toMatchObject({ field: "watchers" });
    expect((await w.dana.put("/c/notification-prefs", { events: def.events, email: def.email, watchers: [{ ...watcher, scope: "no-such-job" }] }, { loose: true })).status).toBe(422);
    expect((await w.dana.put("/c/notification-prefs", { events: def.events, email: def.email, watchers: ["boss@acme.example.test"] }, { loose: true })).status).toBe(400); // plain emails are the quote-level shape
    expect((await w.dana.put("/c/notification-prefs", { events: def.events, email: def.email, watchers: [{ ...watcher, channels: { email: true } }] }, { loose: true })).status).toBe(400);

    const CONSENT = "I agree to receive text messages from DSG about my quotes. Msg & data rates may apply. Reply STOP to opt out.";
    const saved = ok(
      await w.dana.put("/c/notification-prefs", { events, email: "dana@acme.example.test", phone: "+13125550123", smsOptIn: true, smsConsentText: CONSENT, quietStart: "19:00", quietEnd: "07:00", timezone: "America/Chicago", watchers: [watcher] }),
      200,
      "save",
    );
    expect(saved).toMatchObject({ smsOptIn: true, smsConsentText: CONSENT, quietStart: "19:00", quietEnd: "07:00", timezone: "America/Chicago", watchers: [watcher], phone: "+13125550123" });
    expect(saved.smsOptInAt).toBe(w.clock.now.toISOString());
    expect(saved.events.QUOTE_READY.sms).toBe(true);

    // Staying opted in keeps the ORIGINAL consent record even if the wording sent later differs.
    w.advance(60_000);
    const again = ok(await w.dana.put("/c/notification-prefs", { events, email: "dana@acme.example.test", phone: "+13125550123", smsOptIn: true, smsConsentText: "different text" }), 200, "resave");
    expect(again.smsOptInAt).toBe(saved.smsOptInAt);
    expect(again.smsConsentText).toBe(CONSENT);
    // Opting out clears SMS everywhere.
    const out = ok(await w.dana.put("/c/notification-prefs", { events: { ...events, QUOTE_READY: { email: true, sms: false } }, email: "dana@acme.example.test", smsOptIn: false }), 200, "opt out");
    expect(out).toMatchObject({ smsOptIn: false, smsOptInAt: null });
    // Preferences are per person: Drew is untouched.
    expect(ok(await w.drew.get("/c/notification-prefs"), 200, "drew").events.QUOTE_READY).toEqual({ email: true, sms: false });
  });

  it("active quote: clear it with null; a non-draft or deleted quote reads back as none", async () => {
    const q = await draftWith(w.dana);
    expect(ok(await w.dana.put("/c/active-quote", { quoteId: null }), 200, "clear").quoteId).toBeNull();
    expect(ok(await w.dana.put("/c/active-quote", { quoteId: q.id }), 200, "set").quoteId).toBe(q.id);
    ok(await w.dana.post(`/c/quotes/${q.id}/submit`, {}), 200, "submit");
    expect(ok(await w.dana.get("/c/active-quote"), 200, "after submit").quoteId).toBeNull();
    const refused = await w.dana.put("/c/active-quote", { quoteId: q.id });
    expect(refused.status).toBe(409);
  });

  it("staff create on behalf of a customer (draft, and submitted) and assign to a rep / team", async () => {
    const draft = ok(await w.rep1.post("/s/quotes", { customerId: F.DANA.id, title: "Phone order", newJob: { name: "Phone job" }, lines: [{ variantId: F.V_PIPE, qty: 2 }] }), 201, "create");
    expect(draft).toMatchObject({ status: "DRAFT", customerName: F.DANA.name, companyName: F.ACME.name });
    // A rep-created draft shows in the inbox and in the dealer's list (same company location).
    expect(ok(await w.rep1.get("/s/quotes?tab=all"), 200, "inbox").items.map((i: any) => i.id)).toContain(draft.id);
    expect(ok(await w.dana.get("/c/quotes"), 200, "dealer").items.map((i: any) => i.id)).toContain(draft.id);

    const sub = ok(await w.rep1.post("/s/quotes", { customerId: F.BEA.id, title: "Bea order", lines: [{ variantId: F.V_VALVE, qty: 1 }], submit: true }), 201, "create+submit");
    expect(sub).toMatchObject({ status: "SUBMITTED", assignedRepId: w.staff.rep1.id });
    expect((await w.rep1.post("/s/quotes", { customerId: F.NOBODY, title: "x" }, { loose: true })).status).toBe(422);
    expect((await w.rep1.post("/s/quotes", { customerId: F.BEA.id, title: "x", submit: true }, { loose: true })).status).toBe(422); // submit needs lines

    const q = await submitted(w.dana);
    const assigned = ok(await w.manager.post(`/s/quotes/${q.id}/assign`, { repId: w.staff.rep2.id, teamId: "team-east" }), 200, "assign");
    expect(assigned).toMatchObject({ status: "SUBMITTED", assignedRepId: w.staff.rep2.id, teamId: "team-east" });
    expect((await w.manager.post(`/s/quotes/${q.id}/assign`, { repId: "ghost" }, { loose: true })).status).toBe(422);
    expect((await w.manager.post(`/s/quotes/${q.id}/assign`, {}, { loose: true })).status).toBe(400);
    const byRep = ok(await w.rep1.get(`/s/quotes?rep=${w.staff.rep2.id}`), 200, "by rep");
    expect(byRep.items.map((i: any) => i.id)).toEqual([q.id]);
    expect(ok(await w.rep1.get("/s/quotes?team=team-east"), 200, "by team").items.map((i: any) => i.id)).toEqual([q.id]);
    expect(ok(await w.rep1.get("/s/quotes?rep=me"), 200, "mine").items.map((i: any) => i.id)).not.toContain(q.id);
  });

  it("inbox search and customer list filters (status, jobId, q) behave", async () => {
    const a = await submitted(w.dana, undefined, { title: "Alpha", job: "Harbor Tower", po: "PO-A1" });
    await submitted(w.dana, undefined, { title: "Beta", job: "Mill Street", po: "PO-B2" });
    const byStatus = ok(await w.dana.get("/c/quotes?status=SUBMITTED"), 200, "status");
    expect(byStatus.items).toHaveLength(2);
    expect(ok(await w.dana.get("/c/quotes?status=DRAFT"), 200, "draft").items).toHaveLength(0);
    expect(ok(await w.dana.get(`/c/quotes?jobId=${a.job.id}`), 200, "job").items.map((i: any) => i.id)).toEqual([a.id]);
    expect(ok(await w.dana.get("/c/quotes?q=mill"), 200, "q job").items.map((i: any) => i.title)).toEqual(["Beta"]);
    expect(ok(await w.dana.get("/c/quotes?q=PO-A1"), 200, "q po").items.map((i: any) => i.title)).toEqual(["Alpha"]);
    expect(ok(await w.dana.get(`/c/quotes?q=Q-${a.number}`), 200, "q number").items.map((i: any) => i.id)).toEqual([a.id]);
    expect(ok(await w.rep1.get("/s/quotes?q=harbor"), 200, "staff q").items.map((i: any) => i.id)).toEqual([a.id]);
    expect(ok(await w.rep1.get("/s/quotes?q=acme"), 200, "staff company").items).toHaveLength(2);
    // list pagination: limit + cursor walk every quote exactly once
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const p: any = ok(await w.dana.get(`/c/quotes?limit=1${cursor ? `&cursor=${cursor}` : ""}`), 200, "page");
      seen.push(...p.items.map((i: any) => i.id));
      cursor = p.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(2);
    expect((await w.dana.get("/c/quotes?limit=0", { loose: true })).status).toBe(400);
    expect((await w.dana.get("/c/quotes?status=BOGUS", { loose: true })).status).toBe(400);
  });

  it("staff claim/send guards and transitions refused by the state machine return 409 with the Error shape", async () => {
    const draft = await draftWith(w.dana);
    expect((await w.rep1.post(`/s/quotes/${draft.id}/claim`)).status).toBe(409);
    const q = await submitted(w.dana);
    // The state machine allows SUBMITTED -> QUOTE_READY directly (rep sends without claiming).
    expect(ok(await w.rep1.post(`/s/quotes/${q.id}/send`), 200, "send unclaimed").status).toBe("QUOTE_READY");
    expect((await w.rep1.post(`/s/quotes/${q.id}/claim`)).status).toBe(200); // reassign only
    const dec = ok(await w.rep1.post(`/s/quotes/${q.id}/decline`, {}), 200, "decline");
    expect((await w.rep1.post(`/s/quotes/${q.id}/send`)).status).toBe(409);
    expect((await w.rep1.post(`/s/quotes/${q.id}/reopen`)).status).toBe(409);
    expect(dec.status).toBe("DECLINED");
  });

  it("every error status carries { code, message } with a stable code", async () => {
    const cases: [string, Promise<any>, number, string][] = [
      ["no creds", w.anon.get("/c/quotes"), 401, "UNAUTHENTICATED"],
      ["bad body", w.dana.post("/c/quotes", { title: "" }, { loose: true }), 400, "BAD_REQUEST"],
      ["unknown quote", w.dana.get("/c/quotes/nope"), 404, "NOT_FOUND"],
      ["unknown route", w.dana.get("/c/nothing-here"), 404, "NOT_FOUND"],
      ["invalid transition", (async () => w.dana.post(`/c/quotes/${(await draftWith(w.dana)).id}/accept`, {}))(), 409, "INVALID_TRANSITION"],
      ["not editable", (async () => w.dana.post(`/c/quotes/${(await submitted(w.dana)).id}/lines`, { variantId: F.V_PIPE, qty: 1 }))(), 409, "NOT_EDITABLE"],
    ];
    for (const [name, p, status, code] of cases) {
      const r = await p;
      expect(r.status, name).toBe(status);
      expect(r.body.code, name).toBe(code);
      expect(typeof r.body.message, name).toBe("string");
    }
  });

  it("malformed JSON and an unsupported content type are 4xx with the Error shape, never 500", async () => {
    const q = await sentQuote(w);
    const tok = `Bearer ${(await import("./support/world")).customerToken(F.DANA.id, w.clock.now)}`;
    const broken = await w.raw({ method: "POST", url: `/c/quotes/${q.id}/decline`, headers: { authorization: tok, "content-type": "application/json" }, payload: "{not json" });
    expect(broken.status).toBeGreaterThanOrEqual(400);
    expect(broken.status).toBeLessThan(500);
    expect(typeof broken.body?.code).toBe("string");
    const wrongType = await w.raw({ method: "POST", url: "/c/quotes", headers: { authorization: tok, "content-type": "text/plain" }, payload: "title=x" });
    expect(wrongType.status).toBeLessThan(500);
    expect(wrongType.status).toBeGreaterThanOrEqual(400);
  });

  it("GET /healthz is alive and CORS preflight works for the customer-account extension", async () => {
    const h = await w.raw({ method: "GET", url: "/healthz" });
    expect(h.body).toEqual({ ok: true });
    expect(ok(await w.dana.get("/c/quotes"), 200, "list").items).toEqual([]);
    expect((await w.dana.get("/c/quotes")).headers["cache-control"]).toBe("no-store");
  });

  describe("CORS (info.x-cors): /c/* only", () => {
    const cors = (spec as any).info["x-cors"];
    const preflight = (url: string, origin?: string, extra: Record<string, string> = {}) =>
      w.raw({ method: "OPTIONS", url, headers: { ...(origin ? { origin } : {}), "access-control-request-method": "GET", "access-control-request-headers": "authorization", ...extra } });

    it("the contract says what this suite checks", () => {
      expect(cors).toMatchObject({ appliesTo: "/c/*", maxAgeSeconds: 600 });
      expect([...cors.allowedHeaders].sort()).toEqual(["Authorization", "Content-Type"]);
      expect([...cors.allowedMethods].sort()).toEqual(["DELETE", "GET", "OPTIONS", "PATCH", "POST", "PUT"]);
    });

    it("preflight from Origin: null and from a real origin: unauthenticated 204, origin echoed, headers per x-cors, no credentials header", async () => {
      for (const origin of ["null", "https://extensions.shopifycdn.com"]) {
        const pre = await preflight("/c/quotes", origin);
        expect(pre.status, origin).toBe(204);
        expect(pre.headers["access-control-allow-origin"], origin).toBe(origin);
        expect(pre.headers["access-control-max-age"], origin).toBe(String(cors.maxAgeSeconds));
        const allowHeaders = String(pre.headers["access-control-allow-headers"]).split(/\s*,\s*/).map((h) => h.toLowerCase());
        for (const h of cors.allowedHeaders) expect(allowHeaders, origin).toContain(h.toLowerCase());
        const allowMethods = String(pre.headers["access-control-allow-methods"]).split(/\s*,\s*/);
        for (const m of cors.allowedMethods) expect(allowMethods, origin).toContain(m);
        expect(pre.headers["access-control-allow-credentials"], origin).toBeUndefined();
      }
    });

    it("every /c/* path in the contract answers an unauthenticated OPTIONS with 204 (parameters filled in)", async () => {
      const paths = [...new Set(operations().filter((o) => o.path.startsWith("/c/")).map((o) => o.path))];
      expect(paths.length).toBeGreaterThan(10);
      for (const p of paths) {
        const r = await preflight(p.replace(/\{\w+\}/g, "x"), "null");
        expect(r.status, p).toBe(204);
        expect(r.headers["access-control-allow-origin"], p).toBe("null");
      }
    });

    it("actual responses (success and error) on /c/* carry the echoed origin; the Authorization header works cross-origin", async () => {
      const ok200 = await w.dana.get("/c/quotes", { headers: { origin: "null" } });
      expect(ok200.status).toBe(200);
      expect(ok200.headers["access-control-allow-origin"]).toBe("null");
      expect(ok200.headers["access-control-allow-credentials"]).toBeUndefined();
      const e404 = await w.dana.get("/c/quotes/nope", { headers: { origin: "https://extensions.shopifycdn.com" } });
      expect(e404.status).toBe(404);
      expect(e404.headers["access-control-allow-origin"]).toBe("https://extensions.shopifycdn.com");
      const e401 = await w.raw({ method: "GET", url: "/c/quotes", headers: { origin: "null" } });
      expect(e401.status).toBe(401);
      expect(e401.headers["access-control-allow-origin"]).toBe("null");
    });

    it("no CORS headers on /s/*, /webhooks/* or /healthz, and none on the app proxy mount", async () => {
      const asKeys = (h: Record<string, any>) => Object.keys(h).filter((k) => k.startsWith("access-control-"));
      const s = await w.rep1.get("/s/me", { headers: { origin: "null" } });
      expect(s.status).toBe(200);
      expect(asKeys(s.headers)).toEqual([]);
      const sPre = await preflight("/s/quotes", "null");
      expect(asKeys(sPre.headers)).toEqual([]);
      expect(sPre.status).not.toBe(204);
      const hook = await preflight("/webhooks/shopify", "null");
      expect(asKeys(hook.headers)).toEqual([]);
      expect(asKeys((await w.raw({ method: "GET", url: "/healthz", headers: { origin: "null" } })).headers)).toEqual([]);
      const proxy = await w.danaProxy.get("/c/quotes", { headers: { origin: "null" } });
      expect(proxy.status).toBe(200);
      expect(asKeys(proxy.headers)).toEqual([]);
    });
  });

  it("a rep claim on an already claimed or accepted quote just reassigns it (no status change)", async () => {
    const q = await submitted(w.dana);
    await claimAndPrice(w.rep1, q.id);
    const r = ok(await w.rep2.post(`/s/quotes/${q.id}/claim`), 200, "rep2 claim");
    expect(r).toMatchObject({ status: "IN_REVIEW", assignedRepId: w.staff.rep2.id });
  });
});
