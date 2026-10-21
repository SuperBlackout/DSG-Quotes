import { describe, expect, it } from "vitest";
import { CUSTOMER_A, CUSTOMER_B, LOC1, STAFF_REP, V_COSTLY, V_GOOD, draftWith, ensureStaff, sent, submitted, useHarness } from "./helpers";

/** Contract 0.2.0 follow-ups API-1, 2, 3, 6, 7, 8, 11 (customer routes). */
describe("contract 0.2.0 customer follow-ups", () => {
  const h = useHarness();
  const DAY = 24 * 3600 * 1000;

  describe("API-1 from-cart existing carries poNumber, neededBy, notesToSales", () => {
    it("persists the header fields that are present, leaves the others alone, and ignores emptyCart", async () => {
      const q = await draftWith(h, [{ variantId: V_GOOD, qty: 1 }]);
      await h.c.patch(`/c/quotes/${q.id}`, { poNumber: "PO-KEEP", notesToSales: "original note", neededBy: "2026-05-01" });

      const r = await h.c.post("/c/quotes/from-cart", {
        cartLines: [{ variantId: V_COSTLY, qty: 2 }],
        target: { mode: "existing", quoteId: q.id, poNumber: "PO-NEW", neededBy: "2026-07-01", notesToSales: "Dock closes at 3" },
        emptyCart: true, // informational only
      });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ id: q.id, status: "DRAFT", poNumber: "PO-NEW", neededBy: "2026-07-01", notesToSales: "Dock closes at 3" });
      expect(r.body.lines).toHaveLength(2);

      // Only the fields that are present overwrite: here just notesToSales.
      const r2 = await h.c.post("/c/quotes/from-cart", { cartLines: [{ variantId: V_GOOD, qty: 1 }], target: { mode: "existing", quoteId: q.id, notesToSales: "Second note" } });
      expect(r2.status).toBe(201);
      expect(r2.body).toMatchObject({ poNumber: "PO-NEW", neededBy: "2026-07-01", notesToSales: "Second note" });
      // Omitting all three changes none of them.
      const r3 = await h.c.post("/c/quotes/from-cart", { cartLines: [{ variantId: V_GOOD, qty: 1 }], target: { mode: "existing", quoteId: q.id } });
      expect(r3.body).toMatchObject({ poNumber: "PO-NEW", neededBy: "2026-07-01", notesToSales: "Second note" });
      // emptyCart true or false makes no difference to the API result.
      const a = await h.c.post("/c/quotes/from-cart", { cartLines: [{ variantId: V_GOOD, qty: 1 }], target: { mode: "new", title: "A" }, emptyCart: true });
      const b = await h.c.post("/c/quotes/from-cart", { cartLines: [{ variantId: V_GOOD, qty: 1 }], target: { mode: "new", title: "B" }, emptyCart: false });
      expect([a.status, b.status]).toEqual([201, 201]);
    });

    it("a non-draft target, another company's quote and a bad header value are refused without touching the quote", async () => {
      const sub = await submitted(h);
      const r = await h.c.post("/c/quotes/from-cart", { cartLines: [{ variantId: V_GOOD, qty: 1 }], target: { mode: "existing", quoteId: sub.id, poNumber: "X" } });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("NOT_EDITABLE");
      expect((await h.prisma.quote.findUniqueOrThrow({ where: { id: sub.id } })).poNumber).toBe("PO-1");

      const mine = await draftWith(h);
      const other = await h.asCustomer(CUSTOMER_B).post("/c/quotes/from-cart", { cartLines: [{ variantId: V_GOOD, qty: 1 }], target: { mode: "existing", quoteId: mine.id, poNumber: "HACK" } });
      expect(other.status).toBe(404);
      expect((await h.prisma.quote.findUniqueOrThrow({ where: { id: mine.id } })).poNumber).toBe("PO-1");
    });
  });

  describe("API-2 limit up to 100", () => {
    it("status=DRAFT&limit=100 is accepted; larger limits are clamped to 100; 0 and junk are 400", async () => {
      const shop = h.deps.config.shopDomain;
      await h.prisma.quote.createMany({
        data: Array.from({ length: 105 }, (_, i) => ({ shop, number: 20000 + i, title: `Draft ${i}`, customerId: CUSTOMER_A, customerName: "Dana Dealer", companyLocationId: LOC1, status: "DRAFT" as const })),
      });
      const r100 = await h.c.get("/c/quotes?status=DRAFT&limit=100");
      expect(r100.status).toBe(200);
      expect(r100.body.items).toHaveLength(100);
      expect(r100.body.nextCursor).toBeTruthy();
      const rest = await h.c.get(`/c/quotes?status=DRAFT&limit=100&cursor=${r100.body.nextCursor}`);
      expect(rest.body.items).toHaveLength(5);
      expect(rest.body.nextCursor).toBeNull();

      const big = await h.c.get("/c/quotes?status=DRAFT&limit=500"); // clamped, not rejected
      expect(big.status).toBe(200);
      expect(big.body.items).toHaveLength(100);
      expect((await h.c.get("/c/quotes?limit=0")).status).toBe(400);
      expect((await h.c.get("/c/quotes?limit=abc")).status).toBe(400);
      expect((await h.c.get("/c/quotes/x/messages?limit=1000")).status).toBe(404); // same clamping rule on the other paged routes (404 here: no such quote)
    });
  });

  describe("API-3 PUT /c/active-quote", () => {
    it("accepts a just-created own draft (from-cart save as draft, or POST with setActive false) and null; 404 for another company's quote", async () => {
      const saved = await h.c.post("/c/quotes/from-cart", { cartLines: [{ variantId: V_GOOD, qty: 3 }], target: { mode: "new", title: "From cart" }, submit: false });
      expect(saved.status).toBe(201);
      const put = await h.c.put("/c/active-quote", { quoteId: saved.body.id });
      expect(put.status).toBe(200);
      expect(put.body).toEqual({ quoteId: saved.body.id, number: saved.body.number, title: "From cart", lineCount: 1 });

      const other = await h.c.post("/c/quotes", { title: "Other draft", setActive: false });
      expect((await h.c.get("/c/active-quote")).body.quoteId).toBe(saved.body.id);
      const put2 = await h.c.put("/c/active-quote", { quoteId: other.body.id });
      expect(put2.body.quoteId).toBe(other.body.id);

      const cleared = await h.c.put("/c/active-quote", { quoteId: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body).toEqual({ quoteId: null, number: null, title: null, lineCount: null });

      const theirs = await h.asCustomer(CUSTOMER_B).post("/c/quotes", { title: "Theirs" });
      const denied = await h.c.put("/c/active-quote", { quoteId: theirs.body.id });
      expect(denied.status).toBe(404);
      expect((await h.c.get("/c/active-quote")).body.quoteId).toBeNull(); // unchanged by the refused call
      expect((await h.c.put("/c/active-quote", { quoteId: "no-such" })).status).toBe(404);
      const sub = await submitted(h);
      expect((await h.c.put("/c/active-quote", { quoteId: sub.id })).status).toBe(409);
      expect((await h.c.put("/c/active-quote", {})).status).toBe(400);
    });
  });

  describe("API-6 summary fields: assignedRepName, unreadCount, previousTotal, currencyCode", () => {
    it("currencyCode is the shop currency on every summary and detail", async () => {
      const q = await draftWith(h);
      expect(q.currencyCode).toBe("USD");
      h.shopify.buyers.get(CUSTOMER_A)!.currencyCode = "CAD";
      const q2 = await draftWith(h);
      expect(q2.currencyCode).toBe("CAD");
      const list = (await h.c.get("/c/quotes")).body.items;
      expect(list.map((i: any) => i.currencyCode).sort()).toEqual(["CAD", "USD"]);
      h.shopify.buyers.get(CUSTOMER_A)!.currencyCode = "USD";
    });

    it("assignedRepName is null until claimed, then the rep's name (list and detail)", async () => {
      await ensureStaff(h, STAFF_REP, { name: "Rita Rep" });
      const q = await submitted(h);
      expect(q.assignedRepName).toBeNull();
      await h.s.post(`/s/quotes/${q.id}/claim`);
      expect((await h.c.get(`/c/quotes/${q.id}`)).body.assignedRepName).toBe("Rita Rep");
      expect((await h.c.get("/c/quotes")).body.items.find((i: any) => i.id === q.id).assignedRepName).toBe("Rita Rep");
    });

    it("unreadCount counts customer-visible staff messages not yet read, never internal notes or the customer's own; reading the conversation clears it", async () => {
      await ensureStaff(h, STAFF_REP);
      const q = await sent(h);
      const unread = async () => (await h.c.get("/c/quotes")).body.items.find((i: any) => i.id === q.id).unreadCount;
      expect(await unread()).toBe(0);
      await h.s.post(`/s/quotes/${q.id}/messages`, { body: "first" });
      await h.s.post(`/s/quotes/${q.id}/messages`, { body: "second" });
      await h.s.post(`/s/quotes/${q.id}/messages`, { body: "SECRET internal", internal: true });
      await h.c.post(`/c/quotes/${q.id}/messages`, { body: "my own message" });
      expect(await unread()).toBe(2);
      expect((await h.c.get(`/c/quotes/${q.id}`)).body.unreadCount).toBe(2); // detail agrees (and does not mark read)
      await h.c.get(`/c/quotes/${q.id}/messages`);
      expect(await unread()).toBe(0);
      await h.s.post(`/s/quotes/${q.id}/messages`, { body: "third" });
      expect(await unread()).toBe(1);
      // A colleague at another company never sees these counts.
      expect((await h.asCustomer(CUSTOMER_B).get("/c/quotes")).body.items).toHaveLength(0);
    });

    it("previousTotal is the total of the prior sent version, else null", async () => {
      await ensureStaff(h, STAFF_REP);
      const q = await sent(h, [{ variantId: V_GOOD, qty: 2 }]); // v1 = 100.00
      expect(q.total).toBe("100.00");
      expect(q.previousTotal).toBeNull();
      await h.c.post(`/c/quotes/${q.id}/request-changes`, { message: "lower please" });
      const wl = (await h.s.get(`/s/quotes/${q.id}`)).body.workingLines;
      await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: wl.map((l: any) => ({ id: l.id, variantId: l.variantId, qty: l.qty, quotedPrice: "45.00" })) });
      expect((await h.s.post(`/s/quotes/${q.id}/send`)).status).toBe(200);
      const v2 = (await h.c.get(`/c/quotes/${q.id}`)).body;
      expect(v2).toMatchObject({ currentVersion: 2, total: "90.00", previousTotal: "100.00" });
      expect((await h.c.get("/c/quotes")).body.items.find((i: any) => i.id === q.id)).toMatchObject({ total: "90.00", previousTotal: "100.00" });
      // v3 shifts the window: previous is v2.
      await h.c.post(`/c/quotes/${q.id}/request-changes`, { message: "still high" });
      await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: wl.map((l: any) => ({ id: l.id, variantId: l.variantId, qty: l.qty, quotedPrice: "42.50" })) });
      await h.s.post(`/s/quotes/${q.id}/send`);
      expect((await h.c.get(`/c/quotes/${q.id}`)).body).toMatchObject({ currentVersion: 3, total: "85.00", previousTotal: "90.00" });
    });
  });

  describe("API-7 canEditHeader", () => {
    it("is true exactly while the quote is a DRAFT (state machine), on list and detail", async () => {
      await ensureStaff(h, STAFF_REP);
      const d = await draftWith(h);
      expect(d.actions).toMatchObject({ canEditHeader: true, canEditLines: true });
      const s = (await h.c.post(`/c/quotes/${d.id}/submit`, {})).body;
      expect(s.actions).toMatchObject({ canEditHeader: false, canEditLines: false });
      const ready = await sent(h);
      expect(ready.actions.canEditHeader).toBe(false);
      const list = (await h.c.get("/c/quotes")).body.items;
      expect(list.find((i: any) => i.id === d.id).actions.canEditHeader).toBe(false);
      const fresh = await draftWith(h);
      expect((await h.c.get("/c/quotes")).body.items.find((i: any) => i.id === fresh.id).actions.canEditHeader).toBe(true);
      // and the server really does refuse header edits when it says false
      expect((await h.c.patch(`/c/quotes/${d.id}`, { poNumber: "late" })).status).toBe(409);
    });
  });

  describe("API-8 GET /c/quotes/{id}/pdf", () => {
    it("404 for a draft and for a submitted quote with no sent version; 401 anonymous; 404 for another company", async () => {
      const d = await draftWith(h);
      const r = await h.c.get(`/c/quotes/${d.id}/pdf`);
      expect(r.status).toBe(404);
      expect(r.body.code).toBe("NOT_FOUND");
      const s = await submitted(h);
      expect((await h.c.get(`/c/quotes/${s.id}/pdf`)).status).toBe(404);
      expect((await h.raw({ method: "GET", url: `/c/quotes/${s.id}/pdf` })).status).toBe(401);
      await ensureStaff(h, STAFF_REP);
      const ready = await sent(h);
      expect((await h.asCustomer(CUSTOMER_B).get(`/c/quotes/${ready.id}/pdf`)).status).toBe(404);
    });

    it("serves a customer-safe application/pdf inline, for the latest or a chosen version", async () => {
      await ensureStaff(h, STAFF_REP, { name: "Rita Rep" });
      h.shopify.addVariant({ variantId: V_GOOD, price: "50.00", unitCost: "21.43", title: "Good Widget" });
      const q = await submitted(h, [{ variantId: V_GOOD, qty: 2 }]);
      await h.s.post(`/s/quotes/${q.id}/claim`);
      const wl = (await h.s.get(`/s/quotes/${q.id}`)).body.workingLines;
      await h.s.put(`/s/quotes/${q.id}/draft-revision`, {
        lines: wl.map((l: any) => ({ id: l.id, variantId: l.variantId, qty: l.qty, quotedPrice: "45.00", lineNote: "Bulk price" })),
        freight: "12.50",
        repNote: "Ships in 5 days",
        internalNote: "SECRET-INTERNAL-NOTE",
      });
      await h.s.post(`/s/quotes/${q.id}/send`);

      const pdf = await h.c.get(`/c/quotes/${q.id}/pdf`);
      expect(pdf.status).toBe(200);
      expect(pdf.headers["content-type"]).toMatch(/^application\/pdf/);
      expect(pdf.headers["content-disposition"]).toBe(`inline; filename="Q-${q.number}-v1.pdf"`);
      expect(pdf.text.startsWith("%PDF-1.4")).toBe(true);
      expect(pdf.text.trimEnd().endsWith("%%EOF")).toBe(true);
      for (const want of [`Q-${q.number}`, "Version 1", "Good Widget", "Bulk price", "$45.00", "$90.00", "$12.50", "$102.50", "Ships in 5 days", "Dana Dealer", "Acme Dealers"]) {
        expect(pdf.text, want).toContain(want);
      }
      // No cost, margin, internal notes or approval data in the document.
      for (const secret of ["SECRET-INTERNAL-NOTE", "21.43", "margin", "Margin", "floor", "internal"]) expect(pdf.text, secret).not.toContain(secret);

      // ?version=N: a later version is current, version 1 stays available with its own numbers.
      await h.c.post(`/c/quotes/${q.id}/request-changes`, { message: "lower" });
      await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: wl.map((l: any) => ({ id: l.id, variantId: l.variantId, qty: l.qty, quotedPrice: "40.00" })) });
      await h.s.post(`/s/quotes/${q.id}/send`);
      const v2 = await h.c.get(`/c/quotes/${q.id}/pdf`);
      expect(v2.headers["content-disposition"]).toContain(`-v2.pdf`);
      expect(v2.text).toContain("$80.00");
      const v1 = await h.c.get(`/c/quotes/${q.id}/pdf?version=1`);
      expect(v1.status).toBe(200);
      expect(v1.headers["content-disposition"]).toContain(`-v1.pdf`);
      expect(v1.text).toContain("$90.00");
      expect(v1.text).not.toContain("$80.00");
      expect((await h.c.get(`/c/quotes/${q.id}/pdf?version=3`)).status).toBe(404);
      expect((await h.c.get(`/c/quotes/${q.id}/pdf?version=0`)).status).toBe(400);
      expect((await h.c.get(`/c/quotes/${q.id}/pdf?version=abc`)).status).toBe(400);
    });

    it("is also served through the app proxy mount, and wraps long text across pages without breaking the file", async () => {
      await ensureStaff(h, STAFF_REP);
      const q = await sent(h);
      const viaProxy = await h.proxy.get(`/c/quotes/${q.id}/pdf`);
      expect(viaProxy.status).toBe(200);
      expect(viaProxy.text.startsWith("%PDF-1.4")).toBe(true);

      const lines = Array.from({ length: 70 }, (_, i) => ({ variantId: i % 2 ? V_GOOD : V_COSTLY, qty: i + 1 }));
      const big = await submitted(h, lines.slice(0, 2));
      await h.s.post(`/s/quotes/${big.id}/claim`);
      await h.s.put(`/s/quotes/${big.id}/draft-revision`, {
        lines: lines.map((l) => ({ variantId: l.variantId, qty: l.qty, quotedPrice: "60.00", lineNote: "n".repeat(300) })),
        repNote: "long note ".repeat(300),
      });
      await ensureStaff(h, "5002", { isManager: true });
      await h.asStaff("5002").post(`/s/quotes/${big.id}/approve-floor`, {});
      expect((await h.s.post(`/s/quotes/${big.id}/send`)).status).toBe(200);
      const pdf = await h.c.get(`/c/quotes/${big.id}/pdf`);
      expect(pdf.status).toBe(200);
      const pages = Number(/\/Count (\d+)/.exec(pdf.text)![1]);
      expect(pages).toBeGreaterThan(1);
      expect(pdf.text).toContain(`Page ${pages} of ${pages}`);
      // xref offsets are consistent: every "n" entry points at "N 0 obj".
      const buf = Buffer.from(pdf.text, "latin1");
      const xref = buf.toString("latin1").lastIndexOf("xref\n");
      const entries = [...buf.toString("latin1").slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)];
      entries.forEach((m, i) => expect(buf.toString("latin1", Number(m[1]), Number(m[1]) + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    });
  });

  describe("API-11 error semantics", () => {
    it("checkout is 409 NOT_PURCHASABLE (with the status) for a quote that is not ACCEPTED, and for an accepted quote that expired", async () => {
      await ensureStaff(h, STAFF_REP);
      const q = await sent(h);
      const early = await h.c.post(`/c/quotes/${q.id}/checkout`);
      expect(early.status).toBe(409);
      expect(early.body).toMatchObject({ code: "NOT_PURCHASABLE", details: { status: "QUOTE_READY" } });
      expect(h.shopify.createdDraftOrders).toHaveLength(0);

      await h.c.post(`/c/quotes/${q.id}/accept`, { versionNo: 1 });
      h.clock.now = new Date(h.clock.now.getTime() + 15 * DAY);
      const late = await h.c.post(`/c/quotes/${q.id}/checkout`);
      expect(late.status).toBe(409);
      expect(late.body.code).toBe("NOT_PURCHASABLE");
      expect(late.body.message).toMatch(/expired/i);
      expect(h.shopify.createdDraftOrders).toHaveLength(0);
      // "Ask for a new quote": duplicate gives a fresh draft with re-snapshotted prices.
      const dup = await h.c.post(`/c/quotes/${q.id}/duplicate`);
      expect(dup.status).toBe(201);
      expect(dup.body.status).toBe("DRAFT");
    });

    it("accept with a stale versionNo is 409 VERSION_MISMATCH with details.currentVersion, after a resend", async () => {
      await ensureStaff(h, STAFF_REP);
      const q = await sent(h);
      await h.c.post(`/c/quotes/${q.id}/request-changes`, { message: "again" });
      const wl = (await h.s.get(`/s/quotes/${q.id}`)).body.workingLines;
      await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: wl.map((l: any) => ({ id: l.id, variantId: l.variantId, qty: l.qty, quotedPrice: "44.00" })) });
      await h.s.post(`/s/quotes/${q.id}/send`);
      const stale = await h.c.post(`/c/quotes/${q.id}/accept`, { versionNo: 1 });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ code: "VERSION_MISMATCH", details: { currentVersion: 2 } });
      expect((await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("QUOTE_READY");
      const ok = await h.c.post(`/c/quotes/${q.id}/accept`, { versionNo: 2 });
      expect(ok.status).toBe(200);
    });
  });
});
