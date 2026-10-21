import { createHmac } from "node:crypto";
import { buildApp } from "../src/app";
import { describe, expect, it } from "vitest";
import {
  computeAppProxySignature,
  signAppProxyQuery,
  signSessionToken,
  signShopifyWebhook,
  verifyAppProxyRequest,
  verifySessionToken,
  verifyShopifyWebhook,
  type SessionClaims,
} from "../src/auth/crypto";
import { API_KEY, CUSTOMER_A, CUSTOMER_NO_COMPANY, SECRET, SHOP, STAFF_REP, customerToken, staffToken, useHarness } from "./helpers";

// ------------------------------------------------------------------ pure unit tests (fake secrets only)
describe("app proxy signature", () => {
  const now = new Date("2026-03-02T15:00:00Z");
  const base = { shop: SHOP, logged_in_customer_id: "1001", path_prefix: "/apps/quotes" };

  it("verifies a correctly signed query", () => {
    const q = signAppProxyQuery(base, SECRET, now);
    const v = verifyAppProxyRequest(q, SECRET, { now });
    expect(v.ok).toBe(true);
  });

  it("matches Shopify's documented algorithm (sorted key=value, no separator, arrays comma-joined)", () => {
    // Documented example shape: extra=1&extra=2&shop=...&path_prefix=...&timestamp=...
    const params = new URLSearchParams("extra=1&extra=2&shop=some-shop.myshopify.com&path_prefix=%2Fapps%2Fawesome_reviews&timestamp=1317327555");
    const msg = "extra=1,2path_prefix=/apps/awesome_reviewsshop=some-shop.myshopify.comtimestamp=1317327555";
    const expected = createHmac("sha256", "hush").update(msg).digest("hex");
    expect(computeAppProxySignature(params, "hush")).toBe(expected);
  });

  it("rejects tampered params, wrong secret, missing signature, stale and missing timestamp", () => {
    const q = signAppProxyQuery(base, SECRET, now);
    expect(verifyAppProxyRequest(q.replace("1001", "1002"), SECRET, { now })).toMatchObject({ ok: false, reason: "bad signature" });
    expect(verifyAppProxyRequest(q, "other-secret", { now })).toMatchObject({ ok: false, reason: "bad signature" });
    expect(verifyAppProxyRequest(q.replace(/&?signature=[^&]*/, ""), SECRET, { now })).toMatchObject({ ok: false, reason: "missing signature" });
    expect(verifyAppProxyRequest(q, SECRET, { now: new Date(now.getTime() + 10 * 60_000) })).toMatchObject({ ok: false, reason: "stale timestamp" });
    const p = new URLSearchParams(base);
    p.set("signature", computeAppProxySignature(p, SECRET));
    expect(verifyAppProxyRequest(p.toString(), SECRET, { now })).toMatchObject({ ok: false, reason: "missing timestamp" });
  });

  it("a client-added query param invalidates the signature", () => {
    const q = signAppProxyQuery(base, SECRET, now) + "&status=ACCEPTED";
    expect(verifyAppProxyRequest(q, SECRET, { now }).ok).toBe(false);
  });
});

describe("session tokens (HS256 JWT)", () => {
  const now = new Date("2026-03-02T15:00:00Z");
  const t = Math.floor(now.getTime() / 1000);
  const claims: SessionClaims = { iss: `https://${SHOP}/admin`, dest: `https://${SHOP}`, aud: API_KEY, sub: "5001", exp: t + 60, nbf: t - 5 };
  const opts = { secret: SECRET, audience: API_KEY, shopDomain: SHOP, now };

  it("accepts a valid token", () => {
    const v = verifySessionToken(signSessionToken(claims, SECRET), opts);
    expect(v).toMatchObject({ ok: true, claims: { sub: "5001" } });
  });

  it.each([
    ["wrong secret", (c: SessionClaims) => signSessionToken(c, "nope"), "bad signature"],
    ["expired", (c: SessionClaims) => signSessionToken({ ...c, exp: t - 60 }, SECRET), "token expired"],
    ["not yet valid", (c: SessionClaims) => signSessionToken({ ...c, nbf: t + 600 }, SECRET), "token not yet valid"],
    ["wrong audience", (c: SessionClaims) => signSessionToken({ ...c, aud: "other-app" }, SECRET), "wrong audience"],
    ["wrong shop", (c: SessionClaims) => signSessionToken({ ...c, dest: "https://evil.myshopify.com" }, SECRET), "wrong shop"],
    ["no subject", (c: SessionClaims) => signSessionToken({ ...c, sub: "" }, SECRET), "missing subject"],
    ["garbage", () => "not.a.jwt", "malformed token"],
    ["two parts", () => "a.b", "malformed token"],
  ])("rejects %s", (_n, mint, reason) => {
    expect(verifySessionToken(mint(claims), opts)).toEqual({ ok: false, reason });
  });

  it("rejects alg=none and tampered payloads", () => {
    const b = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    expect(verifySessionToken(`${b({ alg: "none" })}.${b(claims)}.`, opts)).toMatchObject({ ok: false });
    const good = signSessionToken(claims, SECRET).split(".");
    const forged = `${good[0]}.${b({ ...claims, sub: "9999" })}.${good[2]}`;
    expect(verifySessionToken(forged, opts)).toEqual({ ok: false, reason: "bad signature" });
  });
});

describe("webhook HMAC", () => {
  it("verifies base64 HMAC over the raw bytes", () => {
    const body = Buffer.from('{"id":1}');
    const sig = signShopifyWebhook(body, SECRET);
    expect(verifyShopifyWebhook(body, sig, SECRET)).toBe(true);
    expect(verifyShopifyWebhook(Buffer.from('{"id":2}'), sig, SECRET)).toBe(false);
    expect(verifyShopifyWebhook(body, undefined, SECRET)).toBe(false);
    expect(verifyShopifyWebhook(body, sig, "other")).toBe(false);
  });
});

// ------------------------------------------------------------------ middleware through the real app
describe("auth middleware", () => {
  const h = useHarness();
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  it("/healthz is public and checks the database", async () => {
    const r = await h.raw({ method: "GET", url: "/healthz" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it("CORS: customer routes answer preflight and allow the Authorization header; staff routes do not", async () => {
    const pre = await h.raw({ method: "OPTIONS", url: "/c/quotes/abc/submit", headers: { origin: "https://extensions.shopifycdn.com", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } });
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe("*");
    expect(pre.headers["access-control-allow-headers"]).toContain("authorization");
    const real = await h.c.get("/c/quotes");
    expect(real.headers["access-control-allow-origin"]).toBe("*");
    const err = await h.raw({ method: "GET", url: "/c/quotes" });
    expect(err.status).toBe(401);
    expect(err.headers["access-control-allow-origin"]).toBe("*"); // so the extension can read the 401 body
    const staff = await h.s.get("/s/reports/summary");
    expect(staff.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("unknown routes return the contract error shape", async () => {
    const r = await h.raw({ method: "GET", url: "/nope" });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ code: "NOT_FOUND", message: "Route not found" });
  });

  it("/c rejects missing credentials, garbage, and a STAFF token", async () => {
    expect((await h.raw({ method: "GET", url: "/c/quotes" })).body.code).toBe("UNAUTHENTICATED");
    expect((await h.raw({ method: "GET", url: "/c/quotes", headers: bearer("garbage") })).status).toBe(401);
    expect((await h.raw({ method: "GET", url: "/c/quotes", headers: bearer(staffToken(STAFF_REP, h.clock.now)) })).status).toBe(401);
  });

  it("EVERY /c and /s route (all mounts) rejects an anonymous request with 401, and the webhook endpoint rejects unsigned posts", async () => {
    const routes: [string, string][] = [];
    const probe = await buildApp(h.deps, { onRoute: (m, url) => m !== "HEAD" && routes.push([m, url]) });
    await probe.ready();
    await probe.close();
    const guarded = routes.filter(([, url]) => /^\/(proxy\/c|c|api\/s|s)\//.test(url));
    expect(guarded.length).toBeGreaterThanOrEqual(70); // 37 routes x 2 mounts
    for (const [method, url] of guarded) {
      const concrete = url.replace(/:\w+/g, "x");
      const r = await h.raw({ method, url: concrete, headers: { "content-type": "application/json" }, payload: method === "GET" || method === "DELETE" ? undefined : "{}" });
      expect(r.status, `${method} ${url}`).toBe(401);
      expect(r.body?.code, `${method} ${url}`).toBe("UNAUTHENTICATED");
    }
    expect((await h.raw({ method: "POST", url: "/webhooks/shopify", headers: { "content-type": "application/json" }, payload: "{}" })).status).toBe(401);
  });

  it("/c accepts a customer-account token and an app proxy signature, resolving the same buyer", async () => {
    const viaToken = await h.raw({ method: "GET", url: "/c/active-quote", headers: bearer(customerToken(CUSTOMER_A, h.clock.now)) });
    expect(viaToken.status).toBe(200);
    const q = signAppProxyQuery({ shop: SHOP, logged_in_customer_id: "1001" }, SECRET, h.clock.now);
    expect((await h.raw({ method: "GET", url: `/proxy/c/active-quote?${q}` })).status).toBe(200);
  });

  it("app proxy: bad signature, tampered customer id, stale timestamp, wrong shop and logged-out visitor are all 401", async () => {
    const good = signAppProxyQuery({ shop: SHOP, logged_in_customer_id: "1001" }, SECRET, h.clock.now);
    const get = (q: string, headers?: Record<string, string>) => h.raw({ method: "GET", url: `/proxy/c/quotes?${q}`, headers });
    expect((await get(good.replace("1001", "2001"))).status).toBe(401);
    expect((await get(signAppProxyQuery({ shop: SHOP, logged_in_customer_id: "1001" }, "wrong", h.clock.now))).status).toBe(401);
    expect((await get(signAppProxyQuery({ shop: SHOP, logged_in_customer_id: "1001" }, SECRET, new Date(h.clock.now.getTime() - 3600_000)))).status).toBe(401);
    expect((await get(signAppProxyQuery({ shop: "evil.myshopify.com", logged_in_customer_id: "1001" }, SECRET, h.clock.now))).status).toBe(401);
    const loggedOut = await get(signAppProxyQuery({ shop: SHOP, logged_in_customer_id: "" }, SECRET, h.clock.now));
    expect(loggedOut.status).toBe(401);
    expect(loggedOut.body.message).toMatch(/sign in/i);
    // A bad signature must NOT fall back to a valid bearer token.
    expect((await get(good.replace("1001", "2001"), bearer(customerToken(CUSTOMER_A, h.clock.now)))).status).toBe(401);
  });

  it("an authenticated customer who is not a company contact gets 403", async () => {
    h.shopify.addBuyer({ customerId: CUSTOMER_NO_COMPANY });
    h.shopify.buyers.delete(CUSTOMER_NO_COMPANY);
    const r = await h.raw({ method: "GET", url: "/c/quotes", headers: bearer(customerToken(CUSTOMER_NO_COMPANY, h.clock.now)) });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("FORBIDDEN");
  });

  it("a gateway that returns a location outside the contact's list is refused", async () => {
    const b = h.shopify.buyers.get(CUSTOMER_A)!;
    const original = b.locations;
    b.locations = [{ id: "gid://shopify/CompanyLocation/77", name: "Other" }];
    expect((await h.c.get("/c/quotes")).status).toBe(403);
    b.locations = original;
  });

  it("/s requires an admin session token; customer tokens and proxy signatures cannot open staff routes", async () => {
    expect((await h.raw({ method: "GET", url: "/s/quotes" })).status).toBe(401);
    expect((await h.raw({ method: "GET", url: "/s/quotes", headers: bearer("garbage") })).status).toBe(401);
    const cust = await h.raw({ method: "GET", url: "/s/quotes", headers: bearer(customerToken(CUSTOMER_A, h.clock.now)) });
    expect(cust.status).toBe(403);
    const proxy = signAppProxyQuery({ shop: SHOP, logged_in_customer_id: "1001" }, SECRET, h.clock.now);
    expect((await h.raw({ method: "GET", url: `/s/quotes?${proxy}` })).status).toBe(401);
    const wrongShop = signSessionToken({ iss: "x", dest: "https://evil.myshopify.com", aud: API_KEY, sub: "5001", exp: Math.floor(h.clock.now.getTime() / 1000) + 60 }, SECRET);
    expect((await h.raw({ method: "GET", url: "/s/quotes", headers: bearer(wrongShop) })).status).toBe(401);
  });

  it("/s auto-provisions a Staff row on first sight and also serves /api/s/*", async () => {
    const r = await h.raw({ method: "GET", url: "/api/s/reports/summary", headers: bearer(staffToken("7777", h.clock.now)) });
    expect(r.status).toBe(200);
    const row = await h.prisma.staff.findFirstOrThrow({ where: { shopifyStaffId: "7777" } });
    expect(row).toMatchObject({ isManager: false });
    expect(row.priceFloorPct.toString()).toBe("15");
    await h.raw({ method: "GET", url: "/s/reports/summary", headers: bearer(staffToken("7777", h.clock.now)) });
    expect(await h.prisma.staff.count({ where: { shopifyStaffId: "7777" } })).toBe(1);
  });

  it("an expired session token is rejected", async () => {
    const old = new Date(h.clock.now.getTime() - 3600_000);
    const r = await h.raw({ method: "GET", url: "/s/quotes", headers: bearer(staffToken(STAFF_REP, old)) });
    expect(r.status).toBe(401);
    expect(r.body.message).toContain("expired");
  });

  it("malformed JSON bodies are a 400 in the contract error shape", async () => {
    const r = await h.raw({ method: "POST", url: "/c/quotes", headers: { ...{ authorization: `Bearer ${customerToken(CUSTOMER_A, h.clock.now)}` }, "content-type": "application/json" }, payload: "{nope" });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("BAD_REQUEST");
  });
});
