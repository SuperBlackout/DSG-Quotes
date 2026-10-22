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

  it("accepts a customer-account token: bare shop domain in dest, no iss", () => {
    const { iss: _iss, ...rest } = claims;
    const cust = { ...rest, dest: SHOP, sub: "gid://shopify/Customer/5001" };
    expect(verifySessionToken(signSessionToken(cust as SessionClaims, SECRET), opts)).toMatchObject({ ok: true });
    expect(verifySessionToken(signSessionToken({ ...cust, dest: "evil.myshopify.com" } as SessionClaims, SECRET), opts)).toEqual({ ok: false, reason: "wrong shop" });
    expect(verifySessionToken(signSessionToken({ ...cust, dest: `${SHOP}.evil.com` } as SessionClaims, SECRET), opts)).toEqual({ ok: false, reason: "wrong shop" });
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

  it("CORS (contract x-cors): echoes the Origin including the literal null, answers any /c/* preflight with an unauthenticated 204, no credentials header", async () => {
    for (const origin of ["https://extensions.shopifycdn.com", "null", "https://dsg.direct"]) {
      const pre = await h.raw({ method: "OPTIONS", url: "/c/quotes/abc/submit", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } });
      expect(pre.status).toBe(204);
      expect(pre.headers["access-control-allow-origin"]).toBe(origin);
      expect(pre.headers["access-control-allow-headers"]).toBe("Authorization, Content-Type");
      expect(pre.headers["access-control-allow-methods"]).toBe("GET, POST, PUT, PATCH, DELETE, OPTIONS");
      expect(pre.headers["access-control-max-age"]).toBe("600");
      expect(pre.headers["access-control-allow-credentials"]).toBeUndefined();
      expect(pre.headers["vary"]).toContain("Origin");
    }
    // Every /c/* path, even ones that do not exist, is preflighted without authentication.
    for (const url of ["/c/quotes", "/c/quotes/from-cart", "/c/quotes/x/lines/y", "/c/notification-prefs", "/c/active-quote", "/c/quotes/x/pdf"]) {
      expect((await h.raw({ method: "OPTIONS", url, headers: { origin: "null" } })).status, url).toBe(204);
    }
    const real = await h.raw({ method: "GET", url: "/c/quotes", headers: { origin: "null", authorization: `Bearer ${customerToken(CUSTOMER_A, h.clock.now)}` } });
    expect(real.status).toBe(200);
    expect(real.headers["access-control-allow-origin"]).toBe("null");
    const err = await h.raw({ method: "GET", url: "/c/quotes", headers: { origin: "https://extensions.shopifycdn.com" } });
    expect(err.status).toBe(401);
    expect(err.headers["access-control-allow-origin"]).toBe("https://extensions.shopifycdn.com"); // so the extension can read the 401 body
    // No Origin header (server to server): nothing to echo.
    expect((await h.c.get("/c/quotes")).headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("CORS: no CORS headers on /s/*, /hooks/* or the app proxy mount, and their OPTIONS requests are not blanket-allowed", async () => {
    const staff = await h.s.get("/s/reports/summary");
    expect(staff.headers["access-control-allow-origin"]).toBeUndefined();
    for (const url of ["/s/quotes", "/api/s/quotes", "/hooks/email-inbound", "/hooks/twilio-inbound", "/proxy/c/quotes", "/webhooks/shopify"]) {
      const r = await h.raw({ method: "OPTIONS", url, headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
      expect(r.headers["access-control-allow-origin"], url).toBeUndefined();
      expect(r.headers["access-control-allow-methods"], url).toBeUndefined();
      expect(r.status, url).not.toBe(204);
    }
    const asStaffWithOrigin = await h.raw({ method: "GET", url: "/s/reports/summary", headers: { origin: "https://evil.example", authorization: `Bearer ${staffToken(STAFF_REP, h.clock.now)}` } });
    expect(asStaffWithOrigin.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("absolute origin vs app proxy: /c takes the session token only, /proxy/c takes the HMAC signature only", async () => {
    const sig = signAppProxyQuery({ shop: SHOP, logged_in_customer_id: "1001" }, SECRET, h.clock.now);
    // A valid app proxy signature does NOT open the absolute-origin route (it has no meaning there).
    const viaSig = await h.raw({ method: "GET", url: `/c/active-quote?${sig}` });
    expect(viaSig.status).toBe(401);
    expect(viaSig.body.message).toMatch(/missing credentials/i);
    // ...and a bearer token does not open the proxy mount.
    const viaToken = await h.raw({ method: "GET", url: "/proxy/c/active-quote", headers: bearer(customerToken(CUSTOMER_A, h.clock.now)) });
    expect(viaToken.status).toBe(401);
    expect(viaToken.body.message).toMatch(/signature/i);
    expect((await h.raw({ method: "GET", url: "/c/active-quote", headers: bearer(customerToken(CUSTOMER_A, h.clock.now)) })).status).toBe(200);
    expect((await h.raw({ method: "GET", url: `/proxy/c/active-quote?${sig}` })).status).toBe(200);
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
    // Bootstrap: the first staff member in a shop becomes its admin, so someone can promote the rest in Settings.
    expect(row).toMatchObject({ role: "admin", active: true, priceFloorPct: null });
    await h.raw({ method: "GET", url: "/s/reports/summary", headers: bearer(staffToken("7777", h.clock.now)) });
    expect(await h.prisma.staff.count({ where: { shopifyStaffId: "7777" } })).toBe(1);
    // Everyone after that starts as a rep with no personal floor (the shop default applies).
    await h.raw({ method: "GET", url: "/s/reports/summary", headers: bearer(staffToken("7778", h.clock.now)) });
    expect(await h.prisma.staff.findFirstOrThrow({ where: { shopifyStaffId: "7778" } })).toMatchObject({ role: "rep", priceFloorPct: null });
  });

  it("a deactivated staff member is refused (403) on every /s route", async () => {
    await h.raw({ method: "GET", url: "/s/reports/summary", headers: bearer(staffToken("7779", h.clock.now)) });
    await h.prisma.staff.update({ where: { shop_shopifyStaffId: { shop: SHOP, shopifyStaffId: "7779" } }, data: { active: false } });
    const r = await h.raw({ method: "GET", url: "/s/quotes", headers: bearer(staffToken("7779", h.clock.now)) });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("FORBIDDEN");
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
