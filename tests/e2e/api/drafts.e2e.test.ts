/**
 * RUNNABLE LAYER: everything a dealer does before and around a quote's trip through sales.
 * Screen 1 (PDP "Add to Quote", through the storefront app proxy), Screen 2 (cart -> quote), Screen 3/4 actions
 * (delete draft, duplicate, withdraw, decline, reopen). Each test starts from an empty database.
 */
import { describe, expect, it } from "vitest";
import { acceptedQuote, claimAndPrice, draftWith, eventTypes, ok, reprice, sentQuote, submitted } from "./support/flows";
import * as F from "./support/fixtures";
import { useWorld } from "./support/world";

describe("Screen 1: PDP 'Add to Quote' (storefront app proxy)", () => {
  const w = useWorld();

  it("a signed app proxy call creates a quote, adds a line and sets the active quote chip", async () => {
    const q = ok(await w.danaProxy.post("/c/quotes", { title: "Lakeview", newJob: { name: "Lakeview Lofts", poNumber: "PO-1" } }), 201, "create");
    const withLine = ok(await w.danaProxy.post(`/c/quotes/${q.id}/lines`, { variantId: F.V_PIPE, qty: 2 }), 201, "add line");
    expect(withLine).toMatchObject({ status: "DRAFT", lineCount: 1, total: "240.00" });
    expect(ok(await w.danaProxy.get("/c/active-quote"), 200, "active")).toMatchObject({ quoteId: q.id, title: "Lakeview", lineCount: 1 });
    // The same quote is reachable with the customer-account token (same customer, same scope).
    expect(ok(await w.dana.get(`/c/quotes/${q.id}`), 200, "bearer").id).toBe(q.id);
  });

  it("the popover list: only my company's DRAFT quotes come back from ?status=DRAFT", async () => {
    const a = await draftWith(w.dana, [{ variantId: F.V_PIPE, qty: 1 }], { title: "Draft A" });
    const b = await draftWith(w.dana, [{ variantId: F.V_VALVE, qty: 1 }], { title: "Draft B" });
    await submitted(w.dana, [{ variantId: F.V_VALVE, qty: 3 }], { title: "Already submitted" });
    await draftWith(w.bea, [{ variantId: F.V_PIPE, qty: 1 }], { title: "Other company draft" });
    const list = ok(await w.danaProxy.get("/c/quotes?status=DRAFT&limit=100"), 200, "list");
    expect(list.items.map((i: any) => i.title).sort()).toEqual(["Draft A", "Draft B"]);
    expect(list.items.every((i: any) => i.status === "DRAFT" && i.actions.canEditLines)).toBe(true);
    // Choosing a draft and adding to it
    ok(await w.danaProxy.put("/c/active-quote", { quoteId: a.id }), 200, "choose A");
    expect(ok(await w.danaProxy.get("/c/active-quote"), 200, "active").quoteId).toBe(a.id);
    const added = ok(await w.danaProxy.post(`/c/quotes/${a.id}/lines`, { variantId: F.V_VALVE, qty: 5 }), 201, "add");
    expect(added.lineCount).toBe(2);
    expect(b.id).not.toBe(a.id);
  });

  it("a colleague at the same company location shares the drafts; another company never sees them", async () => {
    const q = await draftWith(w.dana, [{ variantId: F.V_PIPE, qty: 1 }]);
    expect(ok(await w.drew.get("/c/quotes"), 200, "drew list").items.map((i: any) => i.id)).toContain(q.id);
    expect(ok(await w.drew.get(`/c/quotes/${q.id}`), 200, "drew get").id).toBe(q.id);
    expect(ok(await w.bea.get("/c/quotes"), 200, "bea list").items).toHaveLength(0);
  });

  it("the same contact on a different company location has a separate set of quotes (X-Company-Location-Id)", async () => {
    const main = await draftWith(w.dana, [{ variantId: F.V_PIPE, qty: 1 }], { title: "Main only" });
    expect(ok(await w.danaBranch.get("/c/quotes"), 200, "branch list").items).toHaveLength(0);
    expect((await w.danaBranch.get(`/c/quotes/${main.id}`)).status).toBe(404);
    const branch = await draftWith(w.danaBranch, [{ variantId: F.V_VALVE, qty: 1 }], { title: "Branch only" });
    expect(ok(await w.dana.get("/c/quotes"), 200, "main list").items.map((i: any) => i.id)).toEqual([main.id]);
    expect((await w.dana.get(`/c/quotes/${branch.id}`)).status).toBe(404);
    const row = await w.prisma.quote.findUniqueOrThrow({ where: { id: branch.id } });
    expect(row.companyLocationId).toBe(F.LOC_ACME_BRANCH);
  });

  it("logged-out visitors (no credentials) and customers who are not company contacts are refused", async () => {
    const anon = await w.anon.get("/c/quotes");
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe("UNAUTHENTICATED");
    w.shopify.buyers.delete(F.DREW.id);
    const stranger = await w.drew.get("/c/quotes");
    expect(stranger.status).toBe(403);
    expect(stranger.body.code).toBe("FORBIDDEN");
  });

  it("a validation failure on 'Start a new quote' (blank title / job) is a clean 4xx with the Error shape", async () => {
    for (const body of [{ title: "" }, {}, { title: "x", newJob: { name: "" } }]) {
      const r = await w.dana.post("/c/quotes", body, { loose: true });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.code).toBe("BAD_REQUEST");
    }
  });
});

describe("price snapshots (rule 6) and line editing", () => {
  const w = useWorld();

  it("each company is priced from its own catalog; later catalog changes do not move existing lines", async () => {
    const d = await draftWith(w.dana, [{ variantId: F.V_PIPE, qty: 2 }]);
    const b = await draftWith(w.bea, [{ variantId: F.V_PIPE, qty: 2 }]);
    expect(d.lines[0]).toMatchObject({ listPrice: "120.00", quotedPrice: "120.00" });
    expect(b.lines[0]).toMatchObject({ listPrice: "110.00", quotedPrice: "110.00" });

    w.shopify.addVariant({ variantId: F.V_PIPE, price: "150.00", unitCost: F.COST.PIPE, title: "Copper Pipe 10ft" });
    const after = ok(await w.dana.get(`/c/quotes/${d.id}`), 200, "reload");
    expect(after.lines[0].quotedPrice).toBe("120.00"); // snapshot
    // Adding the same variant again merges into the existing line and keeps its snapshot.
    const more = ok(await w.dana.post(`/c/quotes/${d.id}/lines`, { variantId: F.V_PIPE, qty: 1 }), 201, "add same variant");
    expect(more.lines).toHaveLength(1);
    expect(more.lines[0]).toMatchObject({ qty: 3, quotedPrice: "120.00" });
    // A new product after the change is priced from the current catalog.
    w.shopify.addVariant({ variantId: F.V_VALVE, price: "90.00", unitCost: F.COST.VALVE, title: "Ball Valve 1in" });
    const valve = ok(await w.dana.post(`/c/quotes/${d.id}/lines`, { variantId: F.V_VALVE, qty: 1 }), 201, "add valve");
    expect(valve.lines.map((l: any) => l.quotedPrice)).toEqual(["120.00", "90.00"]);
  });

  it("edit quantity and note, remove a line; totals follow; qty bounds and unknown products are rejected", async () => {
    const q = await draftWith(w.dana, [{ variantId: F.V_PIPE, qty: 2 }, { variantId: F.V_VALVE, qty: 3 }]);
    const [pipe, valve] = q.lines;
    let r = ok(await w.dana.patch(`/c/quotes/${q.id}/lines/${pipe.id}`, { qty: 5, lineNote: "cut to 8ft" }), 200, "patch");
    expect(r.lines[0]).toMatchObject({ qty: 5, lineNote: "cut to 8ft", lineTotal: "600.00" });
    expect(r.total).toBe("840.00");
    r = ok(await w.dana.del(`/c/quotes/${q.id}/lines/${valve.id}`), 200, "delete line");
    expect(r).toMatchObject({ lineCount: 1, total: "600.00" });

    for (const qty of [0, -1, 1.5, 100001]) {
      const bad = await w.dana.patch(`/c/quotes/${q.id}/lines/${pipe.id}`, { qty }, { loose: true });
      expect(bad.status, `qty ${qty}`).toBe(400);
    }
    const ghost = await w.dana.post(`/c/quotes/${q.id}/lines`, { variantId: F.V_GHOST, qty: 1 }, { loose: true });
    expect(ghost.status).toBeGreaterThanOrEqual(400);
    expect(ghost.status).toBeLessThan(500);
    expect((await w.dana.patch(`/c/quotes/${q.id}/lines/does-not-exist`, { qty: 1 })).status).toBe(404);
    expect(ok(await w.dana.get(`/c/quotes/${q.id}`), 200, "reload").lineCount).toBe(1);
  });

  it("header edits: title, PO, needed-by, ship-to, notes; a draft can be re-pointed at an existing job", async () => {
    const q = await draftWith(w.dana, [{ variantId: F.V_PIPE, qty: 1 }], { job: "Job One" });
    const second = ok(await w.dana.post("/c/quotes", { title: "Second", newJob: { name: "Job Two" } }), 201, "second");
    const patched = ok(
      await w.dana.patch(`/c/quotes/${q.id}`, {
        title: "Renamed",
        poNumber: "PO-99",
        neededBy: "2026-04-01",
        notesToSales: "Deliver to the back gate",
        shipTo: { name: "Site office", address1: "1 Main St", city: "Columbus", province: "OH", zip: "43004", country: "US" },
        jobId: second.job.id,
      }),
      200,
      "patch header",
    );
    expect(patched).toMatchObject({ title: "Renamed", poNumber: "PO-99", neededBy: "2026-04-01", notesToSales: "Deliver to the back gate", job: { id: second.job.id, name: "Job Two" } });
    expect(patched.shipTo).toMatchObject({ city: "Columbus", zip: "43004" });
    const foreignJob = (await w.bea.post("/c/quotes", { title: "Bea job", newJob: { name: "Bea only" } })).body.job.id;
    const refused = await w.dana.patch(`/c/quotes/${q.id}`, { jobId: foreignJob }, { loose: true });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("VALIDATION_FAILED");
    expect((await w.dana.patch(`/c/quotes/${q.id}`, {}, { loose: true })).status).toBe(400);
  });
});

describe("Screen 2: cart -> quote", () => {
  const w = useWorld();
  const cart = [
    { variantId: F.V_PIPE, qty: 6 },
    { variantId: F.V_VALVE, qty: 12 },
  ];

  it("'Save as draft' into a NEW quote: a draft with the cart lines, job, PO and needed-by; becomes the active quote", async () => {
    const q = ok(
      await w.danaProxy.post("/c/quotes/from-cart", {
        cartLines: cart,
        target: { mode: "new", title: "Cart job", newJob: { name: "Cart job", poNumber: "PO-5" }, poNumber: "PO-5", neededBy: "2026-05-01", notesToSales: "Competing bid" },
        submit: false,
        emptyCart: true,
      }),
      201,
      "from cart",
    );
    expect(q).toMatchObject({ status: "DRAFT", lineCount: 2, total: "1680.00", poNumber: "PO-5", neededBy: "2026-05-01", notesToSales: "Competing bid" });
    expect(ok(await w.danaProxy.get("/c/active-quote"), 200, "active").quoteId).toBe(q.id);
  });

  it("'Submit to sales' into a NEW quote goes straight to SUBMITTED and shows in the rep inbox", async () => {
    const q = ok(await w.danaProxy.post("/c/quotes/from-cart", { cartLines: cart, target: { mode: "new", title: "Rush job", newJob: { name: "Rush job" } }, submit: true }), 201, "from cart");
    expect(q).toMatchObject({ status: "SUBMITTED", waitingOn: "sales", lineCount: 2 });
    const inbox = ok(await w.rep1.get("/s/quotes?tab=needs_response"), 200, "inbox");
    expect(inbox.items.map((i: any) => i.id)).toEqual([q.id]);
    const staff = ok(await w.rep1.get(`/s/quotes/${q.id}`), 200, "staff");
    expect(staff.workingLines).toHaveLength(2); // the rep's working copy is materialised at submit
  });

  it("'Add to existing' appends to a chosen draft; an empty cart, a foreign draft and a locked quote are refused", async () => {
    const existing = await draftWith(w.dana, [{ variantId: F.V_NOCOST, qty: 1 }]);
    const merged = ok(await w.danaProxy.post("/c/quotes/from-cart", { cartLines: cart, target: { mode: "existing", quoteId: existing.id } }), 201, "merge");
    expect(merged.id).toBe(existing.id);
    expect(merged.lineCount).toBe(3);

    const empty = await w.danaProxy.post("/c/quotes/from-cart", { cartLines: [], target: { mode: "existing", quoteId: existing.id } }, { loose: true });
    expect(empty.status).toBe(400);

    const foreign = await w.bea.post("/c/quotes/from-cart", { cartLines: cart, target: { mode: "existing", quoteId: existing.id } });
    expect(foreign.status).toBe(404);
    expect(ok(await w.dana.get(`/c/quotes/${existing.id}`), 200, "unchanged").lineCount).toBe(3);

    const locked = await submitted(w.dana);
    const refused = await w.dana.post("/c/quotes/from-cart", { cartLines: cart, target: { mode: "existing", quoteId: locked.id } });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("NOT_EDITABLE");
  });

  it("a cart line for a product the buyer cannot be priced for fails the whole request and creates nothing", async () => {
    const before = await w.prisma.quote.count();
    const r = await w.dana.post("/c/quotes/from-cart", { cartLines: [...cart, { variantId: F.V_GHOST, qty: 1 }], target: { mode: "new", title: "Bad cart" } }, { loose: true });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(await w.prisma.quote.count()).toBe(before);
  });
});

describe("Screen 3/4 row actions: withdraw, delete draft, duplicate, decline", () => {
  const w = useWorld();

  it("withdraw: SUBMITTED -> DRAFT, the rep's inbox forgets it and the dealer may edit again", async () => {
    const q = await submitted(w.dana);
    expect(ok(await w.rep1.get("/s/quotes?tab=all"), 200, "inbox").items.map((i: any) => i.id)).toContain(q.id);
    const back = ok(await w.dana.post(`/c/quotes/${q.id}/withdraw`), 200, "withdraw");
    expect(back).toMatchObject({ status: "DRAFT", waitingOn: "customer" });
    expect(back.actions).toMatchObject({ canEditLines: true, canSubmit: true, canWithdraw: false });
    expect(ok(await w.rep1.get("/s/quotes?tab=all"), 200, "inbox").items.map((i: any) => i.id)).not.toContain(q.id);
    ok(await w.dana.post(`/c/quotes/${q.id}/lines`, { variantId: F.V_VALVE, qty: 1 }), 201, "edit again");
    expect(await eventTypes(w, q.id)).toEqual(expect.arrayContaining(["SUBMIT", "WITHDRAW"]));
  });

  it("delete draft: 204, gone from list/get/active quote and the rep inbox; only drafts can be deleted", async () => {
    const q = await draftWith(w.dana);
    expect(ok(await w.dana.get("/c/active-quote"), 200, "active").quoteId).toBe(q.id);
    const del = await w.dana.del(`/c/quotes/${q.id}`);
    expect(del.status).toBe(204);
    expect(del.text).toBe("");
    expect((await w.dana.get(`/c/quotes/${q.id}`)).status).toBe(404);
    expect(ok(await w.dana.get("/c/quotes"), 200, "list").items).toHaveLength(0);
    expect(ok(await w.dana.get("/c/active-quote"), 200, "active").quoteId).toBeNull();
    expect((await w.dana.del(`/c/quotes/${q.id}`)).status).toBe(404); // already deleted
    expect(ok(await w.rep1.get("/s/quotes?tab=all"), 200, "inbox").items).toHaveLength(0);
    const row = await w.prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
    expect(row.status).toBe("ARCHIVED"); // soft delete
    expect(row.deletedAt).not.toBeNull();
    expect(await eventTypes(w, q.id, "DELETE")).toHaveLength(1);

    const locked = await submitted(w.dana);
    const refused = await w.dana.del(`/c/quotes/${locked.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("INVALID_TRANSITION");
  });

  it("another company cannot delete my draft (404) and it survives", async () => {
    const q = await draftWith(w.dana);
    expect((await w.bea.del(`/c/quotes/${q.id}`)).status).toBe(404);
    expect(ok(await w.dana.get(`/c/quotes/${q.id}`), 200, "still there").status).toBe("DRAFT");
  });

  it("duplicate: any quote becomes a new DRAFT with the same job and lines, re-priced from today's catalog", async () => {
    const accepted = await acceptedQuote(w, { prices: { [F.V_PIPE]: "100.00" } });
    w.shopify.addVariant({ variantId: F.V_PIPE, price: "130.00", unitCost: F.COST.PIPE, title: "Copper Pipe 10ft" });
    const copy = ok(await w.dana.post(`/c/quotes/${accepted.id}/duplicate`), 201, "duplicate");
    expect(copy.id).not.toBe(accepted.id);
    expect(copy).toMatchObject({ status: "DRAFT", lineCount: accepted.lineCount, job: { id: accepted.job.id } });
    expect(copy.title).toBe(`${accepted.title} (copy)`);
    expect(copy.lines[0]).toMatchObject({ variantId: F.V_PIPE, qty: accepted.lines[0].qty, quotedPrice: "130.00", listPrice: "130.00" });
    expect(copy.versions).toEqual([]);
    expect(copy.messages).toEqual([]);
    expect(ok(await w.dana.get("/c/active-quote"), 200, "active").quoteId).toBe(copy.id);
    expect(ok(await w.dana.get(`/c/quotes/${accepted.id}`), 200, "original").status).toBe("ACCEPTED"); // untouched
    expect((await w.bea.post(`/c/quotes/${accepted.id}/duplicate`)).status).toBe(404);
  });

  it("customer decline: QUOTE_READY -> DECLINED with the reason in the conversation; terminal", async () => {
    const q = await sentQuote(w);
    const d = ok(await w.dana.post(`/c/quotes/${q.id}/decline`, { reason: "Went with another supplier" }), 200, "decline");
    expect(d).toMatchObject({ status: "DECLINED", waitingOn: "none" });
    expect(d.actions).toMatchObject({ canAccept: false, canBuy: false, canDecline: false, canReopen: false });
    expect(d.messages.map((m: any) => m.body)).toContain("Went with another supplier");
    expect((await w.dana.post(`/c/quotes/${q.id}/accept`, { versionNo: 1 })).status).toBe(409);
    expect((await w.rep1.post(`/s/quotes/${q.id}/send`)).status).toBe(409);
    expect((await w.dana.post(`/c/quotes/${q.id}/checkout`)).body.code).toBe("NOT_PURCHASABLE");
  });

  it("rep decline closes it for the dealer too", async () => {
    const q = await submitted(w.dana);
    const r = ok(await w.rep1.post(`/s/quotes/${q.id}/decline`, { reason: "Out of stock, sorry" }), 200, "staff decline");
    expect(r.status).toBe("DECLINED");
    const view = ok(await w.dana.get(`/c/quotes/${q.id}`), 200, "customer view");
    expect(view).toMatchObject({ status: "DECLINED", waitingOn: "none" });
    expect(view.messages.map((m: any) => m.body)).toContain("Out of stock, sorry");
  });
});

describe("reopen after accept (change of mind before buying)", () => {
  const w = useWorld();

  it("dealer reopens an ACCEPTED quote: back to IN_REVIEW, the draft order is discarded, a new send re-prices checkout", async () => {
    const acc = await acceptedQuote(w, { prices: { [F.V_PIPE]: "100.00" } });
    const first = ok(await w.dana.post(`/c/quotes/${acc.id}/checkout`), 200, "checkout");
    expect(w.shopify.createdDraftOrders).toHaveLength(1);

    const re = ok(await w.dana.post(`/c/quotes/${acc.id}/reopen`), 200, "reopen");
    expect(re).toMatchObject({ status: "IN_REVIEW", waitingOn: "sales" });
    expect(re.actions.canBuy).toBe(false);
    expect(w.shopify.deletedDraftOrders).toEqual([first.draftOrderId]);
    expect((await w.dana.post(`/c/quotes/${acc.id}/checkout`)).body.code).toBe("NOT_PURCHASABLE");

    await reprice(w.rep1, acc.id, { [F.V_PIPE]: "90.00" });
    ok(await w.rep1.post(`/s/quotes/${acc.id}/send`), 200, "send v2");
    const v2 = ok(await w.dana.get(`/c/quotes/${acc.id}`), 200, "view");
    expect(v2.currentVersion).toBe(2);
    ok(await w.dana.post(`/c/quotes/${acc.id}/accept`, { versionNo: 2 }), 200, "accept v2");
    const second = ok(await w.dana.post(`/c/quotes/${acc.id}/checkout`), 200, "checkout again");
    expect(second.draftOrderId).not.toBe(first.draftOrderId);
    expect(w.shopify.createdDraftOrders).toHaveLength(2);
    expect(w.shopify.createdDraftOrders[1]!.input.lines[0]).toMatchObject({ variantId: F.V_PIPE, priceOverride: "90.00" });
  });

  it("the rep can reopen too (staff route)", async () => {
    const acc = await acceptedQuote(w);
    const r = ok(await w.rep1.post(`/s/quotes/${acc.id}/reopen`), 200, "staff reopen");
    expect(r.status).toBe("IN_REVIEW");
    expect(r.draftOrderId).toBeNull();
  });
});

describe("conversation (Screens 4 and 7)", () => {
  const w = useWorld();

  it("a draft has no conversation yet (409), a submitted quote does; both sides see the thread in order", async () => {
    const d = await draftWith(w.dana);
    const early = await w.dana.post(`/c/quotes/${d.id}/messages`, { body: "hello?" });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe("NOT_EDITABLE");

    const q = ok(await w.dana.post(`/c/quotes/${d.id}/submit`, {}), 200, "submit");
    ok(await w.dana.post(`/c/quotes/${q.id}/messages`, { body: "Any chance of free freight?" }), 201, "customer message");
    await claimAndPrice(w.rep1, q.id);
    ok(await w.rep1.post(`/s/quotes/${q.id}/messages`, { body: F.SECRET_INTERNAL_MSG, internal: true }), 201, "internal");
    ok(await w.rep1.post(`/s/quotes/${q.id}/messages`, { body: "Let me ask my manager." }), 201, "reply");
    const customerThread = ok(await w.dana.get(`/c/quotes/${q.id}/messages`), 200, "customer thread");
    expect(customerThread.items.map((m: any) => [m.authorType, m.body])).toEqual([
      ["CUSTOMER", "Any chance of free freight?"],
      ["STAFF", "Let me ask my manager."],
    ]);
    const staffThread = ok(await w.rep1.get(`/s/quotes/${q.id}/messages`), 200, "staff thread");
    expect(staffThread.items.map((m: any) => m.internal)).toEqual([false, true, false]);
  });

  it("message pagination works with cursors and stays free of internal notes", async () => {
    const q = await submitted(w.dana);
    for (let i = 1; i <= 5; i++) {
      ok(await w.dana.post(`/c/quotes/${q.id}/messages`, { body: `customer ${i}` }), 201, "customer msg");
      ok(await w.rep1.post(`/s/quotes/${q.id}/messages`, { body: `${F.SECRET_INTERNAL_MSG} ${i}`, internal: true }), 201, "internal");
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: any = ok(await w.dana.get(`/c/quotes/${q.id}/messages?limit=2${cursor ? `&cursor=${cursor}` : ""}`), 200, "page");
      seen.push(...page.items.map((m: any) => m.body));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(["customer 1", "customer 2", "customer 3", "customer 4", "customer 5"]);
  });

  it("attachments: only files uploaded through the signed upload URL for THIS quote are accepted", async () => {
    const q = await submitted(w.dana);
    const other = await submitted(w.dana);
    const up = ok(await w.dana.post(`/c/quotes/${q.id}/attachments/upload-url`, { name: "spec sheet.pdf", size: 1234, mime: "application/pdf" }), 200, "upload url");
    expect(up.fileUrl).toContain(`/quotes/${q.id}/`);
    const msg = ok(await w.dana.post(`/c/quotes/${q.id}/messages`, { body: "See attached", attachments: [{ url: up.fileUrl, name: "spec sheet.pdf", size: 1234, mime: "application/pdf" }] }), 201, "with attachment");
    expect(msg.attachments).toHaveLength(1);
    const wrongQuote = await w.dana.post(`/c/quotes/${other.id}/messages`, { body: "reuse", attachments: [{ url: up.fileUrl, name: "x.pdf", size: 1, mime: "application/pdf" }] }, { loose: true });
    expect(wrongQuote.status).toBe(422);
    const arbitrary = await w.dana.post(`/c/quotes/${q.id}/messages`, { body: "evil", attachments: [{ url: "https://evil.example.test/x.pdf", name: "x.pdf", size: 1, mime: "application/pdf" }] }, { loose: true });
    expect(arbitrary.status).toBe(422);
    const tooBig = await w.dana.post(`/c/quotes/${q.id}/attachments/upload-url`, { name: "big.zip", size: 26214401, mime: "application/zip" }, { loose: true });
    expect(tooBig.status).toBe(400);
    expect((await w.bea.post(`/c/quotes/${q.id}/attachments/upload-url`, { name: "a.pdf", size: 1, mime: "application/pdf" })).status).toBe(404);
  });
});
