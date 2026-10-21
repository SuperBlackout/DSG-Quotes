/**
 * RUNNABLE LAYER: the customer-route changes of contract 0.2.0 (docs/CONTRACT-FOLLOWUPS.md API-1, 2, 3, 6, 7, 11),
 * driven end to end with the e2e actors. Every response is validated against docs/openapi.yaml and scanned for
 * cost, margin and internal text by the harness.
 */
import { describe, expect, it } from "vitest";
import { acceptedQuote, draftWith, ok, reprice, sentQuote, submitted } from "./support/flows";
import * as F from "./support/fixtures";
import { DAY, useWorld } from "./support/world";

describe("API-1 from-cart into an existing draft carries poNumber, neededBy and notesToSales", () => {
  const w = useWorld();

  it("persists the header fields that are present, leaves the others alone, ignores emptyCart", async () => {
    const q = await draftWith(w.dana, [{ variantId: F.V_PIPE, qty: 1 }]);
    ok(await w.dana.patch(`/c/quotes/${q.id}`, { poNumber: "PO-KEEP", notesToSales: "original note", neededBy: "2026-05-01" }), 200, "header");
    const cart = (qty: number) => [{ variantId: F.V_VALVE, qty }];
    const r = ok(
      await w.dana.post("/c/quotes/from-cart", { cartLines: cart(2), target: { mode: "existing", quoteId: q.id, poNumber: "PO-NEW", neededBy: "2026-07-01", notesToSales: "Dock closes at 3" }, emptyCart: true }),
      201,
      "merge",
    );
    expect(r).toMatchObject({ id: q.id, status: "DRAFT", poNumber: "PO-NEW", neededBy: "2026-07-01", notesToSales: "Dock closes at 3" });
    expect(r.lines).toHaveLength(2);
    const r2 = ok(await w.dana.post("/c/quotes/from-cart", { cartLines: cart(1), target: { mode: "existing", quoteId: q.id, notesToSales: "Second note" } }), 201, "partial");
    expect(r2).toMatchObject({ poNumber: "PO-NEW", neededBy: "2026-07-01", notesToSales: "Second note" });
    const r3 = ok(await w.dana.post("/c/quotes/from-cart", { cartLines: cart(1), target: { mode: "existing", quoteId: q.id } }), 201, "none");
    expect(r3).toMatchObject({ poNumber: "PO-NEW", neededBy: "2026-07-01", notesToSales: "Second note" });
    for (const emptyCart of [true, false]) ok(await w.dana.post("/c/quotes/from-cart", { cartLines: cart(1), target: { mode: "new", title: `E ${emptyCart}` }, emptyCart }), 201, "emptyCart");
  });

  it("refused without touching the quote: a submitted target (409), another company's draft (404), a bad date (400)", async () => {
    const sub = await submitted(w.dana);
    const locked = await w.dana.post("/c/quotes/from-cart", { cartLines: [{ variantId: F.V_PIPE, qty: 1 }], target: { mode: "existing", quoteId: sub.id, poNumber: "X" } });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe("NOT_EDITABLE");
    expect(ok(await w.dana.get(`/c/quotes/${sub.id}`), 200, "same").poNumber).toBe("PO-7731");
    const mine = await draftWith(w.dana);
    const foreign = await w.bea.post("/c/quotes/from-cart", { cartLines: [{ variantId: F.V_PIPE, qty: 1 }], target: { mode: "existing", quoteId: mine.id, poNumber: "HACK" } });
    expect(foreign.status).toBe(404);
    const bad = await w.dana.post("/c/quotes/from-cart", { cartLines: [{ variantId: F.V_PIPE, qty: 1 }], target: { mode: "existing", quoteId: mine.id, neededBy: "2026-02-30" } }, { loose: true });
    expect(bad.status).toBe(400);
    expect(ok(await w.dana.get(`/c/quotes/${mine.id}`), 200, "unchanged")).toMatchObject({ poNumber: "PO-7731", neededBy: null, lineCount: 1 });
  });
});

describe("API-2 list limit up to 100", () => {
  const w = useWorld();

  it("status=DRAFT&limit=100 returns up to 100, pages with a cursor, clamps larger limits, and 0 or junk is 400", async () => {
    const rows = Array.from({ length: 103 }, (_, i) => ({ shop: F.SHOP, number: 30000 + i, title: `Draft ${i}`, customerId: F.DANA.id, customerName: F.DANA.name, companyId: F.ACME.id, companyName: F.ACME.name, companyLocationId: F.LOC_ACME_MAIN, status: "DRAFT" as const }));
    await w.prisma.quote.createMany({ data: rows });
    const page1 = ok(await w.dana.get("/c/quotes?status=DRAFT&limit=100"), 200, "100");
    expect(page1.items).toHaveLength(100);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = ok(await w.dana.get(`/c/quotes?status=DRAFT&limit=100&cursor=${page1.nextCursor}`), 200, "rest");
    expect(page2.items).toHaveLength(3);
    expect(page2.nextCursor).toBeNull();
    expect(new Set([...page1.items, ...page2.items].map((i: any) => i.id)).size).toBe(103);
    expect(ok(await w.dana.get("/c/quotes?status=DRAFT&limit=500", { loose: true }), 200, "clamped").items).toHaveLength(100);
    for (const bad of ["0", "-1", "abc", "1.5"]) expect((await w.dana.get(`/c/quotes?limit=${bad}`, { loose: true })).status, bad).toBe(400);
    // Another company never sees these, whatever the limit.
    expect(ok(await w.bea.get("/c/quotes?status=DRAFT&limit=100"), 200, "bea").items).toEqual([]);
  });
});

describe("API-3 PUT /c/active-quote", () => {
  const w = useWorld();

  it("accepts a just-created own draft and null; 404 for another company's quote; the chip follows 'Save as draft' from the cart", async () => {
    const saved = ok(await w.dana.post("/c/quotes/from-cart", { cartLines: [{ variantId: F.V_PIPE, qty: 3 }], target: { mode: "new", title: "From cart" } }), 201, "from cart");
    const set = ok(await w.dana.put("/c/active-quote", { quoteId: saved.id }), 200, "set active");
    expect(set).toMatchObject({ quoteId: saved.id, number: saved.number, title: "From cart", lineCount: 1 });
    expect(ok(await w.dana.put("/c/active-quote", { quoteId: null }), 200, "clear")).toMatchObject({ quoteId: null, number: null, title: null, lineCount: null });
    expect(ok(await w.dana.get("/c/active-quote"), 200, "read").quoteId).toBeNull();
    const theirs = await draftWith(w.bea);
    const foreign = await w.dana.put("/c/active-quote", { quoteId: theirs.id });
    expect(foreign.status).toBe(404);
    expect(ok(await w.dana.get("/c/active-quote"), 200, "unchanged").quoteId).toBeNull();
    expect((await w.dana.put("/c/active-quote", { quoteId: "ghost" })).status).toBe(404);
  });
});

describe("API-6 summary fields and API-7 canEditHeader", () => {
  const w = useWorld();

  it("currencyCode is the shop currency on every summary and detail", async () => {
    const q = await draftWith(w.dana);
    expect(q.currencyCode).toBe("USD");
    w.shopify.buyers.get(F.DANA.id)!.currencyCode = "CAD";
    const q2 = await draftWith(w.dana);
    expect(q2.currencyCode).toBe("CAD");
    expect(ok(await w.dana.get("/c/quotes"), 200, "list").items.map((i: any) => i.currencyCode).sort()).toEqual(["CAD", "USD"]);
  });

  it("assignedRepName is null until a rep claims, then the rep's name (list and detail), and never an id", async () => {
    const q = await submitted(w.dana);
    expect(q.assignedRepName).toBeNull();
    ok(await w.rep1.post(`/s/quotes/${q.id}/claim`), 200, "claim");
    expect(ok(await w.dana.get(`/c/quotes/${q.id}`), 200, "detail").assignedRepName).toBe(F.REP1.name);
    expect(ok(await w.dana.get("/c/quotes"), 200, "list").items.find((i: any) => i.id === q.id).assignedRepName).toBe(F.REP1.name);
    ok(await w.rep2.post(`/s/quotes/${q.id}/claim`), 200, "reassign");
    expect(ok(await w.dana.get(`/c/quotes/${q.id}`), 200, "detail").assignedRepName).toBe(F.REP2.name);
  });

  it("unreadCount counts customer-visible staff messages not yet read: never internal notes or the dealer's own; opening the conversation clears it", async () => {
    const q = await sentQuote(w);
    const unread = async (who = w.dana) => ok(await who.get("/c/quotes"), 200, "list").items.find((i: any) => i.id === q.id)?.unreadCount;
    expect(await unread()).toBe(0);
    ok(await w.rep1.post(`/s/quotes/${q.id}/messages`, { body: "first" }), 201, "m1");
    ok(await w.rep1.post(`/s/quotes/${q.id}/messages`, { body: "second" }), 201, "m2");
    ok(await w.rep1.post(`/s/quotes/${q.id}/messages`, { body: F.SECRET_INTERNAL_MSG, internal: true }), 201, "internal");
    ok(await w.dana.post(`/c/quotes/${q.id}/messages`, { body: "my own message" }), 201, "own");
    expect(await unread()).toBe(2);
    expect(ok(await w.dana.get(`/c/quotes/${q.id}`), 200, "detail").unreadCount).toBe(2); // reading the detail does not mark messages read
    ok(await w.dana.get(`/c/quotes/${q.id}/messages`), 200, "open conversation");
    expect(await unread()).toBe(0);
    ok(await w.rep1.post(`/s/quotes/${q.id}/messages`, { body: "third" }), 201, "m3");
    expect(await unread()).toBe(1);
    expect(ok(await w.bea.get("/c/quotes"), 200, "bea").items).toEqual([]);
  });

  it("previousTotal is the total of the prior sent version (null with only one), and moves with each new version", async () => {
    const q = await sentQuote(w, { lines: [{ variantId: F.V_PIPE, qty: 2 }], prices: { [F.V_PIPE]: "100.00" } });
    expect(q).toMatchObject({ total: "200.00", previousTotal: null });
    ok(await w.dana.post(`/c/quotes/${q.id}/request-changes`, { message: "lower please" }), 200, "changes");
    ok(await w.rep1.post(`/s/quotes/${q.id}/claim`), 200, "claim");
    await reprice(w.rep1, q.id, { [F.V_PIPE]: "90.00" });
    ok(await w.rep1.post(`/s/quotes/${q.id}/send`), 200, "v2");
    expect(ok(await w.dana.get(`/c/quotes/${q.id}`), 200, "v2")).toMatchObject({ currentVersion: 2, total: "180.00", previousTotal: "200.00" });
    expect(ok(await w.dana.get("/c/quotes"), 200, "list").items.find((i: any) => i.id === q.id)).toMatchObject({ total: "180.00", previousTotal: "200.00" });
    ok(await w.dana.post(`/c/quotes/${q.id}/request-changes`, { message: "still high" }), 200, "changes 2");
    ok(await w.rep1.post(`/s/quotes/${q.id}/claim`), 200, "claim 2");
    await reprice(w.rep1, q.id, { [F.V_PIPE]: "85.00" });
    ok(await w.rep1.post(`/s/quotes/${q.id}/send`), 200, "v3");
    expect(ok(await w.dana.get(`/c/quotes/${q.id}`), 200, "v3")).toMatchObject({ currentVersion: 3, total: "170.00", previousTotal: "180.00" });
  });

  it("canEditHeader is true exactly while the quote is a DRAFT (list and detail), and the server agrees when it says false", async () => {
    const d = await draftWith(w.dana);
    expect(d.actions).toMatchObject({ canEditHeader: true, canEditLines: true });
    ok(await w.dana.patch(`/c/quotes/${d.id}`, { poNumber: "PO-EDIT" }), 200, "edit while draft");
    const s = ok(await w.dana.post(`/c/quotes/${d.id}/submit`, {}), 200, "submit");
    expect(s.actions).toMatchObject({ canEditHeader: false, canEditLines: false });
    const edit = await w.dana.patch(`/c/quotes/${d.id}`, { poNumber: "late" });
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe("NOT_EDITABLE");
    const ready = await sentQuote(w);
    expect(ready.actions.canEditHeader).toBe(false);
    const fresh = await draftWith(w.dana);
    const list = ok(await w.dana.get("/c/quotes"), 200, "list").items;
    expect(list.find((i: any) => i.id === fresh.id).actions.canEditHeader).toBe(true);
    expect(list.find((i: any) => i.id === d.id).actions.canEditHeader).toBe(false);
  });
});

describe("API-11 NOT_PURCHASABLE and VERSION_MISMATCH", () => {
  const w = useWorld();

  it("checkout of a quote that is not ACCEPTED is 409 NOT_PURCHASABLE, and nothing is created in Shopify", async () => {
    for (const make of [() => draftWith(w.dana), () => submitted(w.dana), () => sentQuote(w)]) {
      const q = await make();
      const r = await w.dana.post(`/c/quotes/${q.id}/checkout`);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("NOT_PURCHASABLE");
    }
    expect(w.shopify.createdDraftOrders).toHaveLength(0);
  });

  it("an ACCEPTED quote that expired is NOT_PURCHASABLE, and 'Ask for a new quote' (duplicate) gives a fresh draft with the same lines", async () => {
    const acc = await acceptedQuote(w);
    w.advance(15 * DAY);
    const r = await w.dana.post(`/c/quotes/${acc.id}/checkout`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("NOT_PURCHASABLE");
    expect(w.shopify.createdDraftOrders).toHaveLength(0);
    const copy = ok(await w.dana.post(`/c/quotes/${acc.id}/duplicate`), 201, "duplicate");
    expect(copy).toMatchObject({ status: "DRAFT", lineCount: acc.lineCount });
    expect(copy.id).not.toBe(acc.id);
    expect(ok(await w.dana.get(`/c/quotes/${copy.id}`), 200, "copy").lines.map((l: any) => l.variantId)).toEqual(acc.lines.map((l: any) => l.variantId));
  });

  it("accept of an old version after a resend is 409 VERSION_MISMATCH with details.currentVersion; accepting the current one works", async () => {
    const q = await sentQuote(w);
    ok(await w.dana.post(`/c/quotes/${q.id}/request-changes`, { message: "again" }), 200, "changes");
    ok(await w.rep1.post(`/s/quotes/${q.id}/claim`), 200, "claim");
    await reprice(w.rep1, q.id, { [F.V_PIPE]: "99.00" });
    ok(await w.rep1.post(`/s/quotes/${q.id}/send`), 200, "v2");
    const stale = await w.dana.post(`/c/quotes/${q.id}/accept`, { versionNo: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "VERSION_MISMATCH", details: { currentVersion: 2 } });
    expect(ok(await w.dana.get(`/c/quotes/${q.id}`), 200, "still ready").status).toBe("QUOTE_READY");
    expect(ok(await w.dana.post(`/c/quotes/${q.id}/accept`, { versionNo: 2 }), 200, "accept").status).toBe("ACCEPTED");
  });
});
