/**
 * RUNNABLE LAYER: (1) GET /c/quotes/{id}/pdf (API-8), (2) the customer auth split between the two mounts (API-4):
 * `/c/*` accepts ONLY the customer-account session token (Bearer), `/proxy/c/*` accepts ONLY the app proxy HMAC.
 * Every /c response here is also deep-scanned for cost, margin and internal text by the harness.
 */
import { describe, expect, it } from "vitest";
import { signAppProxyQuery } from "../../../apps/api/src/auth/crypto";
import { acceptedQuote, claimAndPrice, draftWith, ok, reprice, sentQuote, submitted } from "./support/flows";
import * as F from "./support/fixtures";
import { customerToken, staffToken, useWorld } from "./support/world";

describe("GET /c/quotes/{id}/pdf", () => {
  const w = useWorld();

  it("404 until a version has been sent: DRAFT, SUBMITTED and IN_REVIEW quotes have no PDF", async () => {
    const draft = await draftWith(w.dana);
    expect((await w.dana.get(`/c/quotes/${draft.id}/pdf`)).status).toBe(404);
    const sub = await submitted(w.dana);
    const r = await w.dana.get(`/c/quotes/${sub.id}/pdf`);
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("NOT_FOUND");
    await claimAndPrice(w.rep1, sub.id, {}, { internalNote: F.SECRET_INTERNAL_NOTE });
    expect((await w.dana.get(`/c/quotes/${sub.id}/pdf`)).status).toBe(404);
  });

  it("a sent quote returns an inline application/pdf named Q-#####-vN.pdf with the customer-visible content and nothing internal", async () => {
    const q = await sentQuote(w, { prices: { [F.V_PIPE]: "105.00" } });
    const r = await w.dana.get(`/c/quotes/${q.id}/pdf`);
    expect(r.status).toBe(200);
    expect(String(r.headers["content-type"]).split(";")[0]).toBe("application/pdf");
    expect(r.headers["content-disposition"]).toBe(`inline; filename="Q-${q.number}-v1.pdf"`);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.text.startsWith("%PDF-")).toBe(true);
    expect(r.text.trimEnd().endsWith("%%EOF")).toBe(true);
    // Customer-visible facts are in the document text; the harness has already scanned it for costs and margins.
    expect(r.text).toContain(`Q-${q.number}`);
    expect(r.text).toContain("105.00");
    for (const secret of [...F.SECRETS, ...F.COSTS]) expect(r.text.includes(secret), secret).toBe(false);
    for (const word of ["margin", "internalNote", "belowFloor", "costUnknown", "FLOOR_APPROVAL"]) expect(r.text.toLowerCase().includes(word.toLowerCase()), word).toBe(false);
  });

  it("?version=N serves an earlier sent version; unknown, zero or malformed versions are 404/400; staff-only notes never appear", async () => {
    const q = await submitted(w.dana);
    await claimAndPrice(w.rep1, q.id, { [F.V_PIPE]: "100.00" }, { repNote: "first offer", internalNote: F.SECRET_INTERNAL_NOTE });
    ok(await w.rep1.post(`/s/quotes/${q.id}/send`), 200, "v1");
    await reprice(w.rep1, q.id, { [F.V_PIPE]: "90.00" }, { repNote: "second offer", internalNote: F.SECRET_INTERNAL_NOTE });
    ok(await w.rep1.post(`/s/quotes/${q.id}/send`), 200, "v2");
    const cur = await w.dana.get(`/c/quotes/${q.id}/pdf`);
    expect(cur.headers["content-disposition"]).toBe(`inline; filename="Q-${q.number}-v2.pdf"`);
    expect(cur.text).toContain("second offer");
    expect(cur.text).toContain("90.00");
    const v1 = await w.dana.get(`/c/quotes/${q.id}/pdf?version=1`);
    expect(v1.status).toBe(200);
    expect(v1.headers["content-disposition"]).toBe(`inline; filename="Q-${q.number}-v1.pdf"`);
    expect(v1.text).toContain("first offer");
    expect(v1.text).not.toContain("second offer");
    expect(ok(await w.dana.get(`/c/quotes/${q.id}`), 200, "view").versions).toHaveLength(2);
    expect((await w.dana.get(`/c/quotes/${q.id}/pdf?version=3`)).status).toBe(404);
    expect((await w.dana.get(`/c/quotes/${q.id}/pdf?version=0`, { loose: true })).status).toBe(400);
    expect((await w.dana.get(`/c/quotes/${q.id}/pdf?version=abc`, { loose: true })).status).toBe(400);
  });

  it("works for every sent status (ready, accepted, ordered) and through the app proxy mount; other companies and anonymous callers are refused", async () => {
    const acc = await acceptedQuote(w);
    const r = await w.dana.get(`/c/quotes/${acc.id}/pdf`);
    expect(r.status).toBe(200);
    const viaProxy = await w.danaProxy.get(`/c/quotes/${acc.id}/pdf`);
    expect(viaProxy.status).toBe(200);
    expect(viaProxy.route).toBe("/proxy/c/quotes/:id/pdf");
    expect(viaProxy.text).toBe(r.text);
    expect((await w.drew.get(`/c/quotes/${acc.id}/pdf`)).status).toBe(200); // same company location
    expect((await w.bea.get(`/c/quotes/${acc.id}/pdf`)).status).toBe(404);
    expect((await w.danaBranch.get(`/c/quotes/${acc.id}/pdf`)).status).toBe(404);
    expect((await w.anon.get(`/c/quotes/${acc.id}/pdf`)).status).toBe(401);
    expect((await w.dana.get("/c/quotes/ghost/pdf")).status).toBe(404);
  });

  it("an expired quote keeps its PDF readable (the record of what was offered); a withdrawn, never-sent quote has none", async () => {
    const q = await sentQuote(w);
    w.advance(15 * 86400_000);
    expect((await w.dana.get(`/c/quotes/${q.id}/pdf`)).status).toBe(200); // still the record of what was offered
    const sub = await submitted(w.drew);
    ok(await w.drew.post(`/c/quotes/${sub.id}/withdraw`), 200, "withdraw");
    expect((await w.drew.get(`/c/quotes/${sub.id}/pdf`)).status).toBe(404);
  });
});

describe("customer auth is split by mount (API-4)", () => {
  const w = useWorld();
  const bearer = () => `Bearer ${customerToken(F.DANA.id, w.clock.now)}`;
  const proxyQuery = (extra: Record<string, string> = {}) => signAppProxyQuery({ shop: F.SHOP, logged_in_customer_id: F.DANA.id.split("/").pop()!, path_prefix: "/apps/quotes", ...extra }, F.API_SECRET, w.clock.now);

  it("/c/* accepts the Bearer session token and rejects the app proxy signature alone (even a valid one)", async () => {
    expect((await w.raw({ method: "GET", url: "/c/quotes", headers: { authorization: bearer() } })).status).toBe(200);
    const sigOnly = await w.raw({ method: "GET", url: `/c/quotes?${proxyQuery()}` });
    expect(sigOnly.status).toBe(401);
    expect(sigOnly.body.code).toBe("UNAUTHENTICATED");
    // A signature next to a bad token does not rescue the request, and a good token ignores the stray signature.
    expect((await w.raw({ method: "GET", url: `/c/quotes?${proxyQuery()}`, headers: { authorization: "Bearer not-a-token" } })).status).toBe(401);
    expect((await w.raw({ method: "GET", url: `/c/quotes?${proxyQuery()}`, headers: { authorization: bearer() } })).status).toBe(200);
  });

  it("/proxy/c/* accepts the app proxy signature and rejects a Bearer token alone (even a valid one)", async () => {
    expect((await w.raw({ method: "GET", url: `/proxy/c/quotes?${proxyQuery()}` })).status).toBe(200);
    const tokenOnly = await w.raw({ method: "GET", url: "/proxy/c/quotes", headers: { authorization: bearer() } });
    expect(tokenOnly.status).toBe(401);
    expect(tokenOnly.body.code).toBe("UNAUTHENTICATED");
    // A token alongside a bad signature does not rescue it either.
    expect((await w.raw({ method: "GET", url: "/proxy/c/quotes?shop=dsg-e2e.myshopify.com&logged_in_customer_id=1001&timestamp=1&signature=bad", headers: { authorization: bearer() } })).status).toBe(401);
  });

  it("the same quote is reachable through both mounts with the matching credential, and sees the same data", async () => {
    const q = await draftWith(w.dana);
    const direct = ok(await w.dana.get(`/c/quotes/${q.id}`), 200, "direct");
    const proxied = ok(await w.danaProxy.get(`/c/quotes/${q.id}`), 200, "proxy");
    expect(proxied).toEqual(direct);
    // A write through the proxy is visible on the direct mount.
    ok(await w.danaProxy.patch(`/c/quotes/${q.id}`, { title: "Renamed via proxy" }), 200, "patch via proxy");
    expect(ok(await w.dana.get(`/c/quotes/${q.id}`), 200, "reread").title).toBe("Renamed via proxy");
  });

  it("proxy requests: stale timestamp, wrong shop, missing customer (logged out) and tampering are all 401", async () => {
    const stale = signAppProxyQuery({ shop: F.SHOP, logged_in_customer_id: "1001", path_prefix: "/apps/quotes" }, F.API_SECRET, new Date(w.clock.now.getTime() - 10 * 60_000));
    expect((await w.raw({ method: "GET", url: `/proxy/c/quotes?${stale}` })).status).toBe(401);
    const wrongShop = signAppProxyQuery({ shop: "other.myshopify.com", logged_in_customer_id: "1001", path_prefix: "/apps/quotes" }, F.API_SECRET, w.clock.now);
    expect((await w.raw({ method: "GET", url: `/proxy/c/quotes?${wrongShop}` })).status).toBe(401);
    const loggedOut = signAppProxyQuery({ shop: F.SHOP, path_prefix: "/apps/quotes" }, F.API_SECRET, w.clock.now);
    expect((await w.raw({ method: "GET", url: `/proxy/c/quotes?${loggedOut}` })).status).toBe(401);
    const wrongSecret = signAppProxyQuery({ shop: F.SHOP, logged_in_customer_id: "1001", path_prefix: "/apps/quotes" }, "not-the-secret", w.clock.now);
    expect((await w.raw({ method: "GET", url: `/proxy/c/quotes?${wrongSecret}` })).status).toBe(401);
    expect((await w.raw({ method: "GET", url: `/proxy/c/quotes?${proxyQuery()}&extra=1` })).status).toBe(401); // appended after signing
  });

  it("a staff session token opens neither customer mount; a customer token never opens /s/*", async () => {
    const staff = `Bearer ${staffToken(F.REP1.shopifyId, w.clock.now)}`;
    expect((await w.raw({ method: "GET", url: "/c/quotes", headers: { authorization: staff } })).status).toBe(401);
    expect((await w.raw({ method: "GET", url: "/proxy/c/quotes", headers: { authorization: staff } })).status).toBe(401);
    for (const url of ["/s/me", "/s/staff", "/s/teams", "/s/settings", "/s/saved-replies", "/s/customers?q=dana"]) {
      const r = await w.raw({ method: "GET", url, headers: { authorization: bearer() } });
      expect(r.status, url).toBe(403);
    }
  });

  it("X-Company-Location-Id selects among the contact's OWN locations on both mounts and is ignored otherwise", async () => {
    const branch = ok(await w.danaBranch.post("/c/quotes", { title: "Branch job" }), 201, "branch draft");
    expect(branch.companyLocationId ?? F.LOC_ACME_BRANCH).toBe(F.LOC_ACME_BRANCH);
    expect(ok(await w.danaBranch.get("/c/quotes"), 200, "branch list").items.map((i: any) => i.id)).toEqual([branch.id]);
    expect(ok(await w.dana.get("/c/quotes"), 200, "main list").items).toEqual([]);
    // Asking for another company's location does not switch: Dana still sees her main location.
    const foreign = await w.raw({ method: "GET", url: "/c/quotes", headers: { authorization: bearer(), "x-company-location-id": F.LOC_OTHER_HQ } });
    expect(foreign.status).toBe(200);
    expect(foreign.body.items).toEqual([]);
  });
});
