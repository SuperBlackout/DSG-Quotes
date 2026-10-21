/**
 * RUNNABLE LAYER: the full dealer <-> sales story over HTTP against the real API (apps/api) on a real Postgres,
 * with the fake Shopify gateway. One quote travels the whole lifecycle; every step is its own test and later steps
 * depend on earlier ones (isolate: "file").
 *
 *   PDP add -> submit -> rep claim + reprice -> send v1 -> revise + send v2 -> customer diff + request changes
 *   -> rep revises, send v3 -> stale accept refused -> accept v3 -> checkout (idempotent) -> orders/create -> ORDERED
 *
 * Privacy (no cost / margin / internal text in any /c response) and contract conformance are enforced on EVERY
 * response by the harness (support/world.ts), so this file also proves them for the whole flow.
 */
import { describe, expect, it } from "vitest";
import { diffVersions, eventRows, ok, orderPayload } from "./support/flows";
import * as F from "./support/fixtures";
import { DAY, useWorld } from "./support/world";

describe("quote lifecycle: dealer Dana (Acme) and rep Rita", () => {
  const w = useWorld({ isolate: "file" });
  const s: { id: string; number: number; v1?: any; v2?: any; v3?: any; draftOrderId?: string } = { id: "", number: 0 };

  it("Screen 1: PDP 'Start a new quote' creates a draft with a new job and makes it the active quote", async () => {
    const q = ok(await w.dana.post("/c/quotes", { title: "Riverside build", newJob: { name: "Riverside Apartments", poNumber: "PO-7731" }, poNumber: "PO-7731" }), 201, "create");
    s.id = q.id;
    s.number = q.number;
    expect(q).toMatchObject({ status: "DRAFT", waitingOn: "customer", title: "Riverside build", poNumber: "PO-7731", lineCount: 0, total: "0.00" });
    expect(q.number).toBe(10001);
    expect(q.displayNumber).toBe("Q-10001");
    expect(q.job).toMatchObject({ name: "Riverside Apartments", poNumber: "PO-7731" });
    expect(q.actions).toMatchObject({ canEditLines: true, canSubmit: false, canDelete: true, canBuy: false, canAccept: false });

    const active = ok(await w.dana.get("/c/active-quote"), 200, "active");
    expect(active).toMatchObject({ quoteId: q.id, number: 10001, title: "Riverside build" });
  });

  it("Screen 1: 'Add to quote' snapshots the buyer's price into the line and never exposes cost", async () => {
    let q = ok(await w.dana.post(`/c/quotes/${s.id}/lines`, { variantId: F.V_PIPE, qty: 4 }), 201, "add pipe");
    q = ok(await w.dana.post(`/c/quotes/${s.id}/lines`, { variantId: F.V_VALVE, qty: 10, lineNote: "Brass only" }), 201, "add valve");
    expect(q.lines).toHaveLength(2);
    expect(q.lines[0]).toMatchObject({ variantId: F.V_PIPE, qty: 4, listPrice: "120.00", quotedPrice: "120.00", lineTotal: "480.00" });
    expect(q.lines[1]).toMatchObject({ variantId: F.V_VALVE, qty: 10, listPrice: "80.00", quotedPrice: "80.00", lineTotal: "800.00", lineNote: "Brass only" });
    expect(q).toMatchObject({ lineCount: 2, total: "1280.00" });
    expect(q.actions).toMatchObject({ canSubmit: true, canEditLines: true });
    expect(ok(await w.dana.get("/c/active-quote"), 200, "active")).toMatchObject({ quoteId: s.id, lineCount: 2 });
  });

  it("a draft is private to the dealer's company: sales does not see it in the inbox", async () => {
    const inbox = ok(await w.rep1.get("/s/quotes?tab=all"), 200, "inbox");
    expect(inbox.items.map((i: any) => i.id)).not.toContain(s.id);
    expect(ok(await w.rep1.get("/s/reports/summary"), 200, "summary")).toMatchObject({ needsResponse: 0 });
  });

  it("submit: DRAFT -> SUBMITTED, waiting on sales, lines locked", async () => {
    const q = ok(await w.dana.post(`/c/quotes/${s.id}/submit`, { notesToSales: "Competing bid, need it by the 20th", neededBy: "2026-03-20" }), 200, "submit");
    expect(q).toMatchObject({ status: "SUBMITTED", waitingOn: "sales", notesToSales: "Competing bid, need it by the 20th", neededBy: "2026-03-20" });
    expect(q.actions).toMatchObject({ canEditLines: false, canSubmit: false, canWithdraw: true, canDelete: false, canAccept: false, canBuy: false });
    const blocked = await w.dana.post(`/c/quotes/${s.id}/lines`, { variantId: F.V_PIPE, qty: 1 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("NOT_EDITABLE");
  });

  it("Screen 6: the quote lands in 'needs response' and 'unassigned' with the right tiles", async () => {
    for (const tab of ["needs_response", "unassigned", "all"]) {
      const inbox = ok(await w.rep1.get(`/s/quotes?tab=${tab}`), 200, tab);
      const row = inbox.items.find((i: any) => i.id === s.id);
      expect(row, tab).toBeTruthy();
      expect(row).toMatchObject({ status: "SUBMITTED", waitingOn: "sales", customerName: F.DANA.name, companyName: F.ACME.name, jobName: "Riverside Apartments", total: "1280.00", assignedRepId: null });
    }
    expect(ok(await w.rep1.get("/s/quotes?tab=waiting_customer"), 200, "waiting").items).toHaveLength(0);
    expect(ok(await w.rep1.get("/s/reports/summary"), 200, "summary")).toMatchObject({ needsResponse: 1, unassigned: 1 });
  });

  it("Screen 7: rep claims -> IN_REVIEW, assigned to Rita, editor loads cost and margin", async () => {
    const q = ok(await w.rep1.post(`/s/quotes/${s.id}/claim`), 200, "claim");
    expect(q).toMatchObject({ status: "IN_REVIEW", assignedRepId: w.staff.rep1.id, assignedRepName: F.REP1.name, waitingOn: "sales" });
    expect(q.workingLines).toHaveLength(2);
    expect(q.workingLines[0]).toMatchObject({ variantId: F.V_PIPE, cost: F.COST.PIPE, quotedPrice: "120.00", belowFloor: false });
    expect(q.workingLines[0].marginPct).toBeCloseTo(48.86, 1);
    expect(ok(await w.rep1.get("/s/quotes?tab=unassigned"), 200, "unassigned").items.map((i: any) => i.id)).not.toContain(s.id);
    // The dealer now sees who is working on it.
    expect(ok(await w.dana.get(`/c/quotes/${s.id}`), 200, "customer view")).toMatchObject({ status: "IN_REVIEW", assignedRepName: F.REP1.name });
  });

  it("rep reprices and notes: nothing reaches the dealer until Send", async () => {
    const cur = ok(await w.rep1.get(`/s/quotes/${s.id}`), 200, "staff view");
    const lines = cur.workingLines.map((l: any) => ({
      id: l.id,
      variantId: l.variantId,
      qty: l.qty,
      quotedPrice: l.variantId === F.V_PIPE ? "105.00" : "72.50",
    }));
    const saved = ok(
      await w.rep1.put(`/s/quotes/${s.id}/draft-revision`, { lines, freight: "35.00", repNote: "Volume pricing through the 30th", internalNote: F.SECRET_INTERNAL_NOTE }),
      200,
      "save revision",
    );
    expect(saved.workingFreight).toBe("35.00");
    expect(saved.workingInternalNote).toBe(F.SECRET_INTERNAL_NOTE);
    expect(saved.workingLines.map((l: any) => l.quotedPrice)).toEqual(["105.00", "72.50"]);
    // Internal note to colleagues, then a customer-facing message.
    ok(await w.rep1.post(`/s/quotes/${s.id}/messages`, { body: F.SECRET_INTERNAL_MSG, internal: true }), 201, "internal note");
    ok(await w.rep1.post(`/s/quotes/${s.id}/messages`, { body: "Hi Dana, pricing is in. Sending v1 now." }), 201, "message");

    const view = ok(await w.dana.get(`/c/quotes/${s.id}`), 200, "customer view");
    expect(view.versions).toHaveLength(0);
    expect(view.lines.map((l: any) => l.quotedPrice)).toEqual(["120.00", "80.00"]); // still the dealer's own request
    expect(view.total).toBe("1280.00");
  });

  it("send v1: QUOTE_READY with a frozen version, 14 day expiry, correct totals", async () => {
    const q = ok(await w.rep1.post(`/s/quotes/${s.id}/send`), 200, "send v1");
    expect(q).toMatchObject({ status: "QUOTE_READY", waitingOn: "customer", currentVersion: 1 });
    const v = ok(await w.dana.get(`/c/quotes/${s.id}`), 200, "customer view");
    s.v1 = v.versions[0];
    expect(v).toMatchObject({ status: "QUOTE_READY", waitingOn: "customer", currentVersion: 1, total: "1180.00" });
    expect(v.versions).toHaveLength(1);
    expect(s.v1).toMatchObject({ versionNo: 1, subtotal: "1145.00", discountTotal: "135.00", freight: "35.00", total: "1180.00", repNote: "Volume pricing through the 30th" });
    expect(new Date(v.expiresAt).getTime() - w.clock.now.getTime()).toBe(14 * DAY);
    expect(v.actions).toMatchObject({ canAccept: true, canRequestChanges: true, canBuy: false, canEditLines: false, canDecline: true });
    // Only the customer-visible message reaches the dealer.
    expect(v.messages.map((m: any) => m.body)).toEqual(["Hi Dana, pricing is in. Sending v1 now."]);
  });

  it("Screen 6: the quote moves to 'waiting on customer'", async () => {
    expect(ok(await w.rep1.get("/s/quotes?tab=waiting_customer"), 200, "tab").items.map((i: any) => i.id)).toContain(s.id);
    expect(ok(await w.rep1.get("/s/quotes?tab=needs_response"), 200, "tab").items.map((i: any) => i.id)).not.toContain(s.id);
  });

  it("send v2: rep revises a QUOTE_READY quote (reprice + add a gasket) and the dealer sees a diff", async () => {
    const cur = ok(await w.rep1.get(`/s/quotes/${s.id}`), 200, "staff view");
    const lines = [
      ...cur.workingLines.map((l: any) => ({ id: l.id, variantId: l.variantId, qty: l.qty, quotedPrice: l.variantId === F.V_PIPE ? "100.00" : l.quotedPrice })),
      { variantId: F.V_NOCOST, qty: 20, quotedPrice: "9.00" },
    ];
    const saved = ok(await w.rep1.put(`/s/quotes/${s.id}/draft-revision`, { lines, freight: "35.00", repNote: "Added gaskets" }), 200, "save v2 revision");
    expect(saved.nextVersionNo).toBe(2);
    // The gasket has no inventory cost: the margin is unknown, so it needs a manager before it can go out (contract 0.2.0).
    const gasket = saved.workingLines.find((l: any) => l.variantId === F.V_NOCOST);
    expect(gasket).toMatchObject({ costUnknown: true, marginPct: null, belowFloor: true, cost: null });
    const blocked = await w.rep1.post(`/s/quotes/${s.id}/send`);
    expect(blocked.status).toBe(422);
    expect(blocked.body).toMatchObject({ code: "FLOOR_APPROVAL_REQUIRED", details: { lineIds: [gasket.id] } });
    // A rep cannot approve it herself; she asks, the manager approves, then the send goes through.
    expect((await w.rep1.post(`/s/quotes/${s.id}/approve-floor`, {})).status).toBe(403);
    ok(await w.rep1.post(`/s/quotes/${s.id}/request-floor-approval`, { lineIds: [gasket.id], note: "No cost on file" }), 200, "request approval");
    ok(await w.manager.post(`/s/quotes/${s.id}/approve-floor`, { lineIds: [gasket.id] }), 200, "approve");
    ok(await w.rep1.post(`/s/quotes/${s.id}/send`), 200, "send v2");
    const v = ok(await w.dana.get(`/c/quotes/${s.id}`), 200, "customer view");
    expect(v).toMatchObject({ status: "QUOTE_READY", currentVersion: 2 });
    expect(v.versions.map((x: any) => x.versionNo)).toEqual([1, 2]);
    s.v2 = v.versions[1];
    expect(s.v2).toMatchObject({ versionNo: 2, subtotal: "1305.00", freight: "35.00", total: "1340.00", repNote: "Added gaskets" });
    // v1 is immutable history.
    expect(v.versions[0]).toEqual(s.v1);
    expect(diffVersions(s.v1, s.v2)).toEqual([
      { variantId: F.V_PIPE, change: "price", from: "105.00", to: "100.00" },
      { variantId: F.V_NOCOST, change: "added", to: "9.00" },
    ]);
  });

  it("Screen 4: dealer requests changes on v2 -> CHANGES_REQUESTED, waiting on sales, callout for the rep", async () => {
    const text = "Can you do 95 on the pipe and drop the gaskets? Competing bid is lower.";
    const q = ok(await w.dana.post(`/c/quotes/${s.id}/request-changes`, { message: text }), 200, "request changes");
    expect(q).toMatchObject({ status: "CHANGES_REQUESTED", waitingOn: "sales" });
    expect(q.actions).toMatchObject({ canAccept: false, canRequestChanges: false, canBuy: false });
    expect(q.messages.map((m: any) => m.body)).toContain(text);
    const staff = ok(await w.rep1.get(`/s/quotes/${s.id}`), 200, "staff view");
    expect(staff.latestChangeRequest).toBe(text);
    expect(ok(await w.rep1.get("/s/quotes?tab=needs_response"), 200, "tab").items.map((i: any) => i.id)).toContain(s.id);
  });

  it("send v3: rep claims again, gives 95 on pipe, removes the gaskets, sends", async () => {
    const claimed = ok(await w.rep1.post(`/s/quotes/${s.id}/claim`), 200, "claim again");
    expect(claimed.status).toBe("IN_REVIEW");
    const lines = claimed.workingLines
      .filter((l: any) => l.variantId !== F.V_NOCOST)
      .map((l: any) => ({ id: l.id, variantId: l.variantId, qty: l.qty, quotedPrice: l.variantId === F.V_PIPE ? "95.00" : l.quotedPrice }));
    ok(await w.rep1.put(`/s/quotes/${s.id}/draft-revision`, { lines, freight: "35.00", repNote: "Final: pipe at 95, gaskets removed" }), 200, "save v3 revision");
    ok(await w.rep1.post(`/s/quotes/${s.id}/send`), 200, "send v3");
    const v = ok(await w.dana.get(`/c/quotes/${s.id}`), 200, "customer view");
    expect(v).toMatchObject({ status: "QUOTE_READY", currentVersion: 3, total: "1140.00" });
    s.v3 = v.versions[2];
    expect(s.v3).toMatchObject({ versionNo: 3, subtotal: "1105.00", total: "1140.00" });
    expect(diffVersions(s.v2, s.v3)).toEqual([
      { variantId: F.V_PIPE, change: "price", from: "100.00", to: "95.00" },
      { variantId: F.V_NOCOST, change: "removed" },
    ]);
    expect(v.lines.map((l: any) => l.variantId)).toEqual([F.V_PIPE, F.V_VALVE]);
  });

  it("accept with a stale version is refused (409 VERSION_MISMATCH); the quote stays QUOTE_READY", async () => {
    const r = await w.dana.post(`/c/quotes/${s.id}/accept`, { versionNo: 2 });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "VERSION_MISMATCH", details: { currentVersion: 3 } });
    expect(ok(await w.dana.get(`/c/quotes/${s.id}`), 200, "view").status).toBe("QUOTE_READY");
  });

  it("buying before accepting is refused (409 NOT_PURCHASABLE) and creates no draft order", async () => {
    const r = await w.dana.post(`/c/quotes/${s.id}/checkout`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("NOT_PURCHASABLE");
    expect(w.shopify.createdDraftOrders).toHaveLength(0);
  });

  it("accept v3 -> ACCEPTED; the Buy button becomes available", async () => {
    const q = ok(await w.dana.post(`/c/quotes/${s.id}/accept`, { versionNo: 3 }), 200, "accept");
    expect(q).toMatchObject({ status: "ACCEPTED", waitingOn: "customer" });
    expect(q.actions).toMatchObject({ canBuy: true, canAccept: false, canRequestChanges: false, canReopen: true });
    expect(ok(await w.rep1.get("/s/quotes?tab=accepted"), 200, "accepted").items.map((i: any) => i.id)).toContain(s.id);
    expect(ok(await w.rep1.get("/s/reports/summary"), 200, "summary")).toMatchObject({ acceptedThisWeek: 1, acceptedThisWeekValue: "1140.00" });
  });

  it("checkout: draft order with locked prices, freight, company contact, quote tag and PO; second click reuses it", async () => {
    const first = ok(await w.dana.post(`/c/quotes/${s.id}/checkout`), 200, "checkout");
    expect(first.invoiceUrl).toMatch(/^https:\/\//);
    s.draftOrderId = first.draftOrderId;
    expect(w.shopify.createdDraftOrders).toHaveLength(1);
    const input = w.shopify.createdDraftOrders[0]!.input;
    expect(input).toMatchObject({
      quoteLabel: "Q-10001",
      tags: ["quote:Q-10001"],
      customerId: F.DANA.id,
      companyId: F.ACME.id,
      companyLocationId: F.LOC_ACME_MAIN,
      freight: "35.00",
      poNumber: "PO-7731",
    });
    expect(input.lines).toEqual([
      { variantId: F.V_PIPE, quantity: 4, priceOverride: "95.00" },
      { variantId: F.V_VALVE, quantity: 10, priceOverride: "72.50" },
    ]);
    // Idempotent: same draft order, no second Shopify call.
    const second = ok(await w.dana.post(`/c/quotes/${s.id}/checkout`), 200, "checkout again");
    expect(second).toEqual(first);
    expect(w.shopify.createdDraftOrders).toHaveLength(1);
    // Catalog changes after acceptance do not move the locked price (rule 6).
    w.shopify.addVariant({ variantId: F.V_PIPE, price: "500.00", unitCost: F.COST.PIPE, title: "Copper Pipe 10ft" });
    expect(ok(await w.dana.get(`/c/quotes/${s.id}`), 200, "view").lines[0]).toMatchObject({ quotedPrice: "95.00" });
  });

  it("orders/create webhook (matched by the quote tag) -> ORDERED, once, and the order is linked", async () => {
    const r = await w.webhook("orders/create", orderPayload(s.number, 9001));
    expect(r.status).toBe(200);
    expect(r.body).toBeUndefined(); // bare 200, the outcome is in a header
    expect(r.headers["x-webhook-result"]).toBe("ordered");
    const view = ok(await w.dana.get(`/c/quotes/${s.id}`), 200, "view");
    expect(view).toMatchObject({ status: "ORDERED", waitingOn: "none", orderId: "gid://shopify/Order/9001" });
    expect(view.actions).toMatchObject({ canBuy: false, canAccept: false, canReopen: false, canDelete: false, canDecline: false });
    // A re-delivery of the same order changes nothing.
    expect((await w.webhook("orders/create", orderPayload(s.number, 9001))).headers["x-webhook-result"]).toBe("already_ordered");
    // And it can no longer be bought again.
    const again = await w.dana.post(`/c/quotes/${s.id}/checkout`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("NOT_PURCHASABLE");
    expect(w.shopify.createdDraftOrders).toHaveLength(1);
  });

  it("rule 1: every status change wrote exactly one event and the chain from -> to is unbroken", async () => {
    const rows = await eventRows(w, s.id);
    const transitions = rows.filter((e) => (e.payload as any)?.from && (e.payload as any)?.to);
    expect(transitions.map((e) => e.type)).toEqual([
      "SUBMIT", "CLAIM", "SEND_REVISION", "SEND_REVISION", "REQUEST_CHANGES", "CLAIM", "SEND_REVISION", "ACCEPT", "ORDER_PLACED",
    ]);
    let status = "DRAFT";
    for (const e of transitions) {
      const p = e.payload as { from: string; to: string };
      expect(p.from, `${e.type} starts from the previous status`).toBe(status);
      status = p.to;
    }
    expect(status).toBe("ORDERED");
    const row = await w.prisma.quote.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.status).toBe("ORDERED");
    expect(transitions.at(-1)!.actorType).toBe("SYSTEM");
    expect(transitions[0]!.actorType).toBe("CUSTOMER");
    expect(transitions[1]!.actorType).toBe("STAFF");
  });

  it("the staff view of the finished quote keeps cost, margin and internal text; the dealer view of it keeps none", async () => {
    const staff = ok(await w.rep1.get(`/s/quotes/${s.id}`), 200, "staff view");
    const staffText = JSON.stringify(staff);
    expect(staffText).toContain(F.SECRET_INTERNAL_MSG);
    expect(staffText).toContain(F.COST.PIPE);
    expect(staff.versions).toHaveLength(3);
    expect(staff.messages.some((m: any) => m.internal)).toBe(true);
    expect(staff.events.length).toBeGreaterThan(8);
    // The harness already scanned every /c response above; prove it really ran.
    expect(w.leakScans.count).toBeGreaterThan(20);
  });

  it("the whole story created only customer-visible notification events for visible messages", async () => {
    const messageEvents = await eventRows(w, s.id, "NEW_MESSAGE");
    const visible = await w.prisma.message.count({ where: { quoteId: s.id, internal: false, authorType: "STAFF" } });
    const internal = await w.prisma.message.count({ where: { quoteId: s.id, internal: true } });
    expect(internal).toBe(1);
    expect(messageEvents).toHaveLength(visible); // rep's visible message only; the request-changes text rides on REQUEST_CHANGES
  });
});
