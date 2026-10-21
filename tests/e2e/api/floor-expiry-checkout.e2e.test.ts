/**
 * RUNNABLE LAYER: price-floor approval (Screen 7), expiry, and accept -> buy edge cases (Screen 4 "Buy now").
 * The worker's hourly EXPIRE cron does not exist yet; `w.runExpiryCron()` is a stand-in that applies the same
 * system EXPIRE transition through apps/api's transition code.
 */
import { describe, expect, it } from "vitest";
import { acceptedQuote, claimAndPrice, draftWith, eventRows, ok, orderPayload, reprice, sentQuote, submitted } from "./support/flows";
import * as F from "./support/fixtures";
import { DAY, useWorld } from "./support/world";

describe("floor approval flow (Screen 7)", () => {
  const w = useWorld();
  const thin = [{ variantId: F.V_THIN, qty: 3 }];

  async function belowFloor() {
    const q = await submitted(w.dana, thin);
    const staff = await claimAndPrice(w.rep1, q.id); // 100.00 on cost 91.43 = 8.57% < 15% floor
    return { q, line: staff.workingLines[0], staff };
  }

  it("a line under the rep's floor is flagged, shows on the inbox row, and Send is blocked with FLOOR_APPROVAL_REQUIRED", async () => {
    const { q, line, staff } = await belowFloor();
    expect(line).toMatchObject({ belowFloor: true, floorApproved: false, cost: F.COST.THIN });
    expect(staff.belowFloor).toBe(true);
    const row = ok(await w.rep1.get("/s/quotes?tab=needs_response"), 200, "inbox").items.find((i: any) => i.id === q.id);
    expect(row.belowFloor).toBe(true);
    const blocked = await w.rep1.post(`/s/quotes/${q.id}/send`);
    expect(blocked.status).toBe(422);
    expect(blocked.body).toMatchObject({ code: "FLOOR_APPROVAL_REQUIRED", details: { lineIds: [line.id] } });
    expect(ok(await w.dana.get(`/c/quotes/${q.id}`), 200, "customer").status).toBe("IN_REVIEW"); // nothing was sent
    expect((await w.prisma.quoteVersion.count({ where: { quoteId: q.id } }))).toBe(0);
  });

  it("only a manager can approve; then the send succeeds and the dealer never learns about the floor", async () => {
    const { q, line } = await belowFloor();
    const denied = await w.rep1.post(`/s/quotes/${q.id}/approve-floor`, {});
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("FORBIDDEN");
    const approved = ok(await w.manager.post(`/s/quotes/${q.id}/approve-floor`, { note: F.SECRET_APPROVAL_NOTE }), 200, "approve");
    expect(approved.workingLines[0]).toMatchObject({ id: line.id, belowFloor: true, floorApproved: true });
    expect(approved.belowFloor).toBe(false);
    ok(await w.rep1.post(`/s/quotes/${q.id}/send`), 200, "send");
    const view = ok(await w.dana.get(`/c/quotes/${q.id}`), 200, "customer"); // privacy scan runs on this response
    expect(view).toMatchObject({ status: "QUOTE_READY", total: "300.00" });
    expect(await eventRows(w, q.id, "FLOOR_APPROVED")).toHaveLength(1);
  });

  it("editing an approved line's price resets the approval; approving specific / unknown line ids", async () => {
    const { q, line } = await belowFloor();
    expect((await w.manager.post(`/s/quotes/${q.id}/approve-floor`, { lineIds: ["ghost"] })).status).toBe(422);
    ok(await w.manager.post(`/s/quotes/${q.id}/approve-floor`, { lineIds: [line.id] }), 200, "approve line");
    const lowered = await reprice(w.rep1, q.id, { [F.V_THIN]: "95.00" }); // still under the floor, new price
    expect(lowered.workingLines[0]).toMatchObject({ belowFloor: true, floorApproved: false });
    expect((await w.rep1.post(`/s/quotes/${q.id}/send`)).body.code).toBe("FLOOR_APPROVAL_REQUIRED");
  });

  it("pricing at or above the floor, or on a line with unknown cost, needs no approval", async () => {
    const q = await submitted(w.dana, [{ variantId: F.V_THIN, qty: 1 }, { variantId: F.V_NOCOST, qty: 1 }]);
    await claimAndPrice(w.rep1, q.id, { [F.V_THIN]: "110.00", [F.V_NOCOST]: "1.00" }); // 16.9% margin; cost unknown
    ok(await w.rep1.post(`/s/quotes/${q.id}/send`), 200, "send");
  });

  it("the floor is the assigned rep's own percentage", async () => {
    await w.prisma.staff.update({ where: { id: w.staff.rep2.id }, data: { priceFloorPct: 5 } });
    const q = await submitted(w.dana, thin); // 8.57% margin: under rep1's 15, over rep2's 5
    await claimAndPrice(w.rep2, q.id);
    ok(await w.rep2.post(`/s/quotes/${q.id}/send`), 200, "rep2 send");
  });
});

describe("expiry", () => {
  const w = useWorld();

  it("default validity is 14 days; a rep-chosen date wins; a past date is refused", async () => {
    const q = await submitted(w.dana);
    await claimAndPrice(w.rep1, q.id, {}, { expiresAt: new Date(w.clock.now.getTime() - DAY).toISOString() });
    const past = await w.rep1.post(`/s/quotes/${q.id}/send`);
    expect(past.status).toBe(422);
    const when = new Date(w.clock.now.getTime() + 5 * DAY).toISOString();
    await reprice(w.rep1, q.id, {}, { expiresAt: when });
    ok(await w.rep1.post(`/s/quotes/${q.id}/send`), 200, "send");
    expect(ok(await w.dana.get(`/c/quotes/${q.id}`), 200, "view").expiresAt).toBe(when);
  });

  it("past its expiry a QUOTE_READY quote cannot be accepted; the attempt records the EXPIRE transition", async () => {
    const q = await sentQuote(w);
    w.advance(15 * DAY);
    const stale = ok(await w.dana.get(`/c/quotes/${q.id}`), 200, "view");
    expect(stale.actions).toMatchObject({ canAccept: false, canBuy: false });
    const r = await w.dana.post(`/c/quotes/${q.id}/accept`, { versionNo: 1 });
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/expired/i);
    const after = ok(await w.dana.get(`/c/quotes/${q.id}`), 200, "view");
    expect(after).toMatchObject({ status: "EXPIRED", waitingOn: "none" });
    expect((await eventRows(w, q.id, "EXPIRE")).map((e) => e.actorType)).toEqual(["SYSTEM"]);
    // "Ask for a new quote": the dealer can copy it into a fresh draft.
    expect(ok(await w.dana.post(`/c/quotes/${q.id}/duplicate`), 201, "duplicate").status).toBe("DRAFT");
  });

  it("the hourly cron stand-in expires QUOTE_READY and unbought ACCEPTED quotes, and nothing else", async () => {
    const ready = await sentQuote(w);
    const accepted = await acceptedQuote(w);
    const fresh = await submitted(w.dana);
    const ordered = await acceptedQuote(w);
    await w.webhook("orders/create", orderPayload(ordered.number, 777));
    w.advance(15 * DAY);
    const done = await w.runExpiryCron();
    expect(done.sort()).toEqual([ready.id, accepted.id].sort());
    const status = async (id: string) => (await w.dana.get(`/c/quotes/${id}`)).body.status;
    expect(await status(ready.id)).toBe("EXPIRED");
    expect(await status(accepted.id)).toBe("EXPIRED");
    expect(await status(fresh.id)).toBe("SUBMITTED");
    expect(await status(ordered.id)).toBe("ORDERED");
  });

  it("an ACCEPTED quote that lapses before purchase cannot be bought: 409 NOT_PURCHASABLE, no draft order", async () => {
    const acc = await acceptedQuote(w);
    w.advance(15 * DAY);
    expect(ok(await w.dana.get(`/c/quotes/${acc.id}`), 200, "view").actions.canBuy).toBe(false);
    const r = await w.dana.post(`/c/quotes/${acc.id}/checkout`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("NOT_PURCHASABLE");
    expect(w.shopify.createdDraftOrders).toHaveLength(0);
    expect(ok(await w.dana.get(`/c/quotes/${acc.id}`), 200, "view").status).toBe("EXPIRED");
  });

  it("'expiring' tab and tile list quotes that lapse within 3 days", async () => {
    const soon = await submitted(w.dana);
    await claimAndPrice(w.rep1, soon.id, {}, { expiresAt: new Date(w.clock.now.getTime() + 2 * DAY).toISOString() });
    ok(await w.rep1.post(`/s/quotes/${soon.id}/send`), 200, "send");
    await sentQuote(w); // 14 days: not expiring
    expect(ok(await w.rep1.get("/s/quotes?tab=expiring"), 200, "tab").items.map((i: any) => i.id)).toEqual([soon.id]);
    expect(ok(await w.rep1.get("/s/reports/summary"), 200, "summary").expiringSoon).toBe(1);
  });
});

describe("checkout (accept -> buy)", () => {
  const w = useWorld();

  it("net-terms locations complete the draft order instead of collecting card payment", async () => {
    w.shopify.buyers.get(F.DANA.id)!.paymentTermsTemplateId = "gid://shopify/PaymentTermsTemplate/4";
    const acc = await acceptedQuote(w);
    ok(await w.dana.post(`/c/quotes/${acc.id}/checkout`), 200, "checkout");
    expect(w.shopify.completedDraftOrders).toHaveLength(1);
    expect(w.shopify.createdDraftOrders[0]!.input.paymentTermsTemplateId).toBe("gid://shopify/PaymentTermsTemplate/4");
  });

  it("a Shopify failure leaves no half-state: the quote stays ACCEPTED and a retry works", async () => {
    const acc = await acceptedQuote(w);
    w.shopify.failNextCreate = new Error("shopify is down");
    const failed = await w.dana.post(`/c/quotes/${acc.id}/checkout`);
    expect(failed.status).toBe(500);
    expect(failed.body.code).toBe("INTERNAL");
    expect(failed.text).not.toMatch(/shopify is down/); // internals are not echoed
    const row = await w.prisma.quote.findUniqueOrThrow({ where: { id: acc.id } });
    expect(row).toMatchObject({ status: "ACCEPTED", draftOrderId: null });
    ok(await w.dana.post(`/c/quotes/${acc.id}/checkout`), 200, "retry");
  });

  it("two Buy clicks at once create exactly one draft order", async () => {
    const acc = await acceptedQuote(w);
    const [a, b] = await Promise.all([w.dana.post(`/c/quotes/${acc.id}/checkout`), w.dana.post(`/c/quotes/${acc.id}/checkout`)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.draftOrderId).toBe(b.body.draftOrderId);
    expect(w.shopify.createdDraftOrders).toHaveLength(1);
  });

  it("another company cannot check out my accepted quote", async () => {
    const acc = await acceptedQuote(w);
    expect((await w.bea.post(`/c/quotes/${acc.id}/checkout`)).status).toBe(404);
    expect(w.shopify.createdDraftOrders).toHaveLength(0);
  });

  it("orders/create: matched by draft order id, ignored for unrelated or non-ACCEPTED quotes, rejects bad signatures", async () => {
    const acc = await acceptedQuote(w);
    const co = ok(await w.dana.post(`/c/quotes/${acc.id}/checkout`), 200, "checkout");
    const early = await sentQuote(w);
    expect((await w.webhook("orders/create", orderPayload(early.number, 1))).body.result).toBe("ignored_status");
    expect((await w.webhook("orders/create", { id: 2, admin_graphql_api_id: "gid://shopify/Order/2", tags: "vip" })).body.result).toBe("no_matching_quote");
    expect((await w.webhook("orders/create", orderPayload(acc.number, 3), { secret: "wrong" })).status).toBe(401);
    expect((await w.webhook("orders/create", orderPayload(acc.number, 3), { shop: "evil.myshopify.com" })).status).toBe(401);
    expect((await w.dana.get(`/c/quotes/${acc.id}`)).body.status).toBe("ACCEPTED");
    const r = await w.webhook("orders/create", { id: 55, draft_order_id: Number(co.draftOrderId.split("/").pop()), tags: "" });
    expect(r.body.result).toBe("ordered");
    expect((await w.dana.get(`/c/quotes/${acc.id}`)).body).toMatchObject({ status: "ORDERED", orderId: "gid://shopify/Order/55" });
    expect((await w.webhook("orders/create", { id: 55, draft_order_id: 1 }, { id: "same" })).status).toBe(200);
  });

  it("draft_orders/update records the status and never changes the quote status itself", async () => {
    const acc = await acceptedQuote(w);
    const co = ok(await w.dana.post(`/c/quotes/${acc.id}/checkout`), 200, "checkout");
    const r = await w.webhook("draft_orders/update", { admin_graphql_api_id: co.draftOrderId, status: "invoice_sent" });
    expect(r.body.result).toBe("draft_order_synced");
    expect((await w.dana.get(`/c/quotes/${acc.id}`)).body.status).toBe("ACCEPTED");
  });

  it("customer-data redaction wipes personal data from the dealer's quotes", async () => {
    const q = await draftWith(w.dana);
    const r = await w.webhook("customers/redact", { customer: { id: Number(F.DANA.id.split("/").pop()) } });
    expect(r.body.result).toBe("customer_redacted");
    const row = await w.prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
    expect(row.customerName).toBe("Redacted");
  });
});
