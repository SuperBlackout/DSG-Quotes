/**
 * RUNNABLE LAYER: privacy (CLAUDE.md rules 3, 4, 5) and company scoping, end to end.
 * The harness deep-scans every /c response for cost, margin, floor data and planted internal text; this file builds
 * the nastiest scenario (thin margins, approvals, internal notes before and after send, unsent edits) and calls
 * every customer endpoint on it, then proves the scanner itself can fail.
 */
import { describe, expect, it } from "vitest";
import { findLeaks } from "./support/leak";
import { acceptedQuote, claimAndPrice, draftWith, ok, reprice, sentQuote, submitted } from "./support/flows";
import * as F from "./support/fixtures";
import { signAppProxyQuery } from "../../../apps/api/src/auth/crypto";
import { customerToken, staffToken, useWorld } from "./support/world";

describe("privacy: internal notes, cost and margin never reach a dealer", () => {
  const w = useWorld();

  async function nastyQuote() {
    const q = await submitted(w.dana, [{ variantId: F.V_PIPE, qty: 2 }, { variantId: F.V_THIN, qty: 3 }, { variantId: F.V_NOCOST, qty: 1 }]);
    await claimAndPrice(w.rep1, q.id, { [F.V_PIPE]: "95.00" }, { freight: "10.00", repNote: "Customer-visible note", internalNote: F.SECRET_INTERNAL_NOTE });
    ok(await w.manager.post(`/s/quotes/${q.id}/approve-floor`, { note: F.SECRET_APPROVAL_NOTE }), 200, "approve");
    ok(await w.rep1.post(`/s/quotes/${q.id}/messages`, { body: F.SECRET_INTERNAL_MSG, internal: true }), 201, "internal");
    ok(await w.rep1.post(`/s/quotes/${q.id}/messages`, { body: "Hi Dana, v1 is ready" }), 201, "visible");
    ok(await w.rep1.post(`/s/quotes/${q.id}/send`), 200, "send");
    // After sending: more internal text and an unsent working edit that must stay invisible.
    ok(await w.rep1.post(`/s/quotes/${q.id}/messages`, { body: `${F.SECRET_INTERNAL_MSG} again`, internal: true }), 201, "internal 2");
    await reprice(w.rep1, q.id, { [F.V_PIPE]: "75.00" }, { internalNote: F.SECRET_WORKING_NOTE, repNote: F.SECRET_WORKING_NOTE });
    return q.id as string;
  }

  it("every customer endpoint on that quote is clean (cost, margin, floor flags, internal text, staff-only keys)", async () => {
    const id = await nastyQuote();
    const draft = await draftWith(w.dana, [{ variantId: F.V_THIN, qty: 1 }]);
    const before = w.leakScans.count;
    const responses: [string, any][] = [];
    const take = async (label: string, p: Promise<{ status: number; body: any }>) => {
      const r = await p;
      expect(r.status, label).toBeLessThan(300);
      responses.push([label, r.body]);
    };
    await take("list", w.dana.get("/c/quotes"));
    await take("list drafts", w.dana.get("/c/quotes?status=DRAFT"));
    await take("search", w.dana.get("/c/quotes?q=Riverside"));
    await take("get sent", w.dana.get(`/c/quotes/${id}`));
    await take("get draft", w.dana.get(`/c/quotes/${draft.id}`));
    await take("messages", w.dana.get(`/c/quotes/${id}/messages`));
    await take("post message", w.dana.post(`/c/quotes/${id}/messages`, { body: "Thanks!" }));
    await take("patch header", w.dana.patch(`/c/quotes/${draft.id}`, { title: "t2" }));
    await take("add line", w.dana.post(`/c/quotes/${draft.id}/lines`, { variantId: F.V_VALVE, qty: 1 }));
    await take("duplicate", w.dana.post(`/c/quotes/${id}/duplicate`));
    await take("request changes", w.dana.post(`/c/quotes/${id}/request-changes`, { message: "please adjust" }));
    await take("active quote", w.dana.get("/c/active-quote"));
    await take("prefs", w.dana.get("/c/notification-prefs"));
    await take("proxy get", w.danaProxy.get(`/c/quotes/${id}`));
    expect(w.leakScans.count - before).toBeGreaterThanOrEqual(responses.length);
    for (const [label, body] of responses) expect(findLeaks(JSON.stringify(body), body), label).toEqual([]);

    // What the dealer does see is the SENT version, not the working edit.
    const view = responses.find(([l]) => l === "get sent")![1];
    expect(view.versions).toHaveLength(1);
    expect(view.versions[0].repNote).toBe("Customer-visible note");
    expect(view.lines.find((l: any) => l.variantId === F.V_PIPE).quotedPrice).toBe("95.00");
    expect(view.messages.map((m: any) => m.body)).toEqual(["Hi Dana, v1 is ready"]);
  });

  it("error responses on customer routes are clean too", async () => {
    const id = await nastyQuote();
    for (const r of [
      await w.dana.post(`/c/quotes/${id}/lines`, { variantId: F.V_PIPE, qty: 1 }),
      await w.dana.post(`/c/quotes/${id}/checkout`),
      await w.dana.post(`/c/quotes/${id}/accept`, { versionNo: 9 }),
      await w.dana.del(`/c/quotes/${id}`),
      await w.bea.get(`/c/quotes/${id}`),
    ]) {
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(findLeaks(r.text, r.body)).toEqual([]);
    }
  });

  it("the same data DOES reach staff routes, so the scan above is meaningful", async () => {
    const id = await nastyQuote();
    const staff = JSON.stringify(ok(await w.rep1.get(`/s/quotes/${id}`), 200, "staff view"));
    for (const s of [F.COST.PIPE, F.COST.THIN, F.SECRET_INTERNAL_NOTE, F.SECRET_INTERNAL_MSG, F.SECRET_WORKING_NOTE, "marginPct", "belowFloor"]) expect(staff).toContain(s);
  });

  it("internal notes create no events (the worker can never notify the dealer about them); public replies do", async () => {
    const q = await submitted(w.dana);
    await claimAndPrice(w.rep1, q.id);
    ok(await w.rep1.post(`/s/quotes/${q.id}/messages`, { body: F.SECRET_INTERNAL_MSG, internal: true }), 201, "internal");
    expect(await w.prisma.event.count({ where: { quoteId: q.id, type: "NEW_MESSAGE" } })).toBe(0);
    ok(await w.rep1.post(`/s/quotes/${q.id}/messages`, { body: "public" }), 201, "public");
    expect(await w.prisma.event.count({ where: { quoteId: q.id, type: "NEW_MESSAGE" } })).toBe(1);
    const events = await w.prisma.event.findMany({ where: { quoteId: q.id } });
    expect(JSON.stringify(events)).not.toContain(F.SECRET_INTERNAL_MSG);
  });

  it("the scanner itself fails on leaks (guards the guard)", () => {
    expect(findLeaks("{}", { lines: [{ cost: "61.37" }] }).join()).toContain('forbidden key "cost"');
    expect(findLeaks(`{"x":"${F.SECRET_INTERNAL_NOTE}"}`, { x: F.SECRET_INTERNAL_NOTE }).join()).toContain("internal text");
    expect(findLeaks(`{"price":"${F.COST.PIPE}"}`, { price: F.COST.PIPE }).join()).toContain("unit cost");
    expect(findLeaks(`{"t":"1161.37"}`, { t: "1161.37" })).toEqual([]); // a longer number containing the digits is not a hit
    expect(findLeaks("{}", { messages: [{ internal: true }] }).join()).toContain('"internal"');
  });
});

describe("authentication boundaries", () => {
  const w = useWorld();

  it("customer tokens never open staff routes and staff tokens never open customer routes", async () => {
    const asCustomer = await w.raw({ method: "GET", url: "/s/quotes", headers: { authorization: `Bearer ${customerToken(F.DANA.id, w.clock.now)}` } });
    expect(asCustomer.status).toBe(403);
    const asStaff = await w.raw({ method: "GET", url: "/c/quotes", headers: { authorization: `Bearer ${staffToken(F.REP1.shopifyId, w.clock.now)}` } });
    expect(asStaff.status).toBe(401);
    expect((await w.anon.get("/s/quotes")).status).toBe(401);
    expect((await w.anon.get("/c/quotes")).status).toBe(401);
  });

  it("expired and forged tokens, and tampered / stale app proxy signatures, are rejected", async () => {
    const old = new Date(w.clock.now.getTime() - 3600_000);
    expect((await w.raw({ method: "GET", url: "/c/quotes", headers: { authorization: `Bearer ${customerToken(F.DANA.id, old)}` } })).status).toBe(401);
    const forged = customerToken(F.DANA.id, w.clock.now).replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    expect((await w.raw({ method: "GET", url: "/c/quotes", headers: { authorization: `Bearer ${forged}` } })).status).toBe(401);
    const bad = await w.raw({ method: "GET", url: "/proxy/c/quotes?shop=dsg-e2e.myshopify.com&logged_in_customer_id=1001&timestamp=1&signature=deadbeef" });
    expect(bad.status).toBe(401);
    // Swapping the customer id in a correctly signed proxy URL breaks the signature (cannot impersonate Bea).
    const q = signAppProxyQuery({ shop: F.SHOP, logged_in_customer_id: "1001", path_prefix: "/apps/quotes" }, F.API_SECRET, w.clock.now).replace("logged_in_customer_id=1001", "logged_in_customer_id=2001");
    expect((await w.raw({ method: "GET", url: `/proxy/c/quotes?${q}` })).status).toBe(401);
    expect((await w.danaProxy.get("/c/quotes")).route).toBe("/proxy/c/quotes"); // a good one works
  });
});

describe("cross-company access is 404 on every customer route (rule 3)", () => {
  const w = useWorld();

  it("Bea (Other Co) and Dana-at-Branch get 404 for Dana's quote in every lifecycle state, and nothing changes", async () => {
    const draft = await draftWith(w.dana);
    const subm = await submitted(w.dana);
    const ready = await sentQuote(w);
    const accepted = await acceptedQuote(w);
    const lineId = draft.lines[0].id;
    const before = await w.prisma.quote.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, updatedAt: true, draftOrderId: true } });

    const attackers = [w.bea, w.danaBranch];
    for (const who of attackers) {
      for (const q of [draft, subm, ready, accepted]) {
        const id = q.id;
        const calls: [string, Promise<any>][] = [
          ["GET", who.get(`/c/quotes/${id}`)],
          ["PATCH", who.patch(`/c/quotes/${id}`, { title: "pwned" })],
          ["DELETE", who.del(`/c/quotes/${id}`)],
          ["add line", who.post(`/c/quotes/${id}/lines`, { variantId: F.V_PIPE, qty: 1 })],
          ["patch line", who.patch(`/c/quotes/${id}/lines/${lineId}`, { qty: 99 })],
          ["delete line", who.del(`/c/quotes/${id}/lines/${lineId}`)],
          ["submit", who.post(`/c/quotes/${id}/submit`, {})],
          ["withdraw", who.post(`/c/quotes/${id}/withdraw`)],
          ["accept", who.post(`/c/quotes/${id}/accept`, {})],
          ["request-changes", who.post(`/c/quotes/${id}/request-changes`, { message: "x" })],
          ["decline", who.post(`/c/quotes/${id}/decline`, {})],
          ["reopen", who.post(`/c/quotes/${id}/reopen`)],
          ["duplicate", who.post(`/c/quotes/${id}/duplicate`)],
          ["checkout", who.post(`/c/quotes/${id}/checkout`)],
          ["messages GET", who.get(`/c/quotes/${id}/messages`)],
          ["messages POST", who.post(`/c/quotes/${id}/messages`, { body: "hi" })],
          ["upload-url", who.post(`/c/quotes/${id}/attachments/upload-url`, { name: "a.pdf", size: 1, mime: "application/pdf" })],
          ["active-quote", who.put("/c/active-quote", { quoteId: id })],
          ["from-cart existing", who.post("/c/quotes/from-cart", { cartLines: [{ variantId: F.V_PIPE, qty: 1 }], target: { mode: "existing", quoteId: id } })],
        ];
        for (const [name, p] of calls) {
          const r = await p;
          expect(r.status, `${who.label} ${name} on ${q.status}`).toBe(404);
          expect(r.body.code).toBe("NOT_FOUND");
        }
      }
      const list = ok(await who.get("/c/quotes"), 200, "list");
      expect(list.items.map((i: any) => i.id)).not.toContain(draft.id);
    }
    const after = await w.prisma.quote.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, updatedAt: true, draftOrderId: true } });
    expect(after).toEqual(before);
    expect(w.shopify.createdDraftOrders).toHaveLength(0);
    expect(await w.prisma.activeQuote.count({ where: { customerId: F.BEA.id } })).toBe(0);
  });

  it("staff routes answer 404 (not 500) for unknown quotes", async () => {
    for (const [m, p] of [["get", "/s/quotes/nope"], ["post", "/s/quotes/nope/claim"], ["post", "/s/quotes/nope/send"], ["get", "/s/quotes/nope/messages"]] as const) {
      const r = await (w.rep1 as any)[m](p);
      expect(r.status, p).toBe(404);
    }
  });
});
