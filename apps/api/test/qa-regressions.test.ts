import { describe, expect, it } from "vitest";
import { isCalendarDate } from "../src/dates";
import { STAFF_REP, V_COSTLY, V_GOOD, draftWith, ensureStaff, eventsOf, submitted, useHarness } from "./helpers";

/**
 * Regression tests for the four bugs QA found (each used to be a 500 or a wrong 2xx):
 *  1. neededBy must be a real calendar date.
 *  2. draft-revision expiresAt with an absurd UTC offset.
 *  3. money / quantity overflow beyond the DB DECIMAL width.
 *  4. staff customer-visible message on a DRAFT.
 */
describe("QA regressions", () => {
  const h = useHarness();
  const quoteCount = () => h.prisma.quote.count();

  describe("1. neededBy is a real calendar date (never a 500, never stored)", () => {
    const BAD = ["2026-13-45", "2026-02-31", "2026-00-10", "2026-04-31", "2026-02-29", "2026-01-00", "2026-1-5", "20260105", "2026-01-05T00:00:00Z", "0000-01-01", "", "tomorrow"];

    it("isCalendarDate: leap years, month lengths, junk", () => {
      for (const ok of ["2026-01-31", "2028-02-29", "2000-02-29", "2026-12-31", "1999-04-30"]) expect(isCalendarDate(ok), ok).toBe(true);
      for (const bad of BAD) expect(isCalendarDate(bad), bad).toBe(false);
      expect(isCalendarDate("1900-02-29")).toBe(false); // 1900 was not a leap year
    });

    it("POST /c/quotes: 400 for every impossible date and no quote row is created", async () => {
      for (const neededBy of BAD) {
        const r = await h.c.post("/c/quotes", { title: "X", neededBy });
        expect(r.status, neededBy).toBe(400);
        expect(r.body.code).toBe("BAD_REQUEST");
      }
      expect(await quoteCount()).toBe(0);
      const ok = await h.c.post("/c/quotes", { title: "Leap", neededBy: "2028-02-29" });
      expect(ok.status).toBe(201);
      expect(ok.body.neededBy).toBe("2028-02-29");
    });

    it("PATCH /c/quotes/:id: 400 and the stored value is unchanged; null clears it", async () => {
      const q = await draftWith(h);
      expect((await h.c.patch(`/c/quotes/${q.id}`, { neededBy: "2026-05-01" })).body.neededBy).toBe("2026-05-01");
      for (const neededBy of ["2026-13-45", "2026-02-31", "2026-04-31"]) {
        const r = await h.c.patch(`/c/quotes/${q.id}`, { neededBy });
        expect(r.status, neededBy).toBe(400);
        const row = await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
        expect(row.neededBy?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
      }
      expect((await h.c.patch(`/c/quotes/${q.id}`, { neededBy: null })).body.neededBy).toBeNull();
    });

    it("POST /c/quotes/:id/submit: 400, the quote stays a DRAFT and nothing is stored", async () => {
      const q = await draftWith(h);
      for (const neededBy of ["2026-13-45", "2026-02-31"]) {
        const r = await h.c.post(`/c/quotes/${q.id}/submit`, { neededBy });
        expect(r.status, neededBy).toBe(400);
      }
      const row = await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
      expect(row).toMatchObject({ status: "DRAFT", neededBy: null });
      expect(await eventsOf(h, q.id, "SUBMIT")).toHaveLength(0);
      const ok = await h.c.post(`/c/quotes/${q.id}/submit`, { neededBy: "2026-06-30" });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ status: "SUBMITTED", neededBy: "2026-06-30" });
    });

    it("POST /c/quotes/from-cart (new and existing): 400 and nothing is created or appended", async () => {
      const cartLines = [{ variantId: V_GOOD, qty: 1 }];
      const r1 = await h.c.post("/c/quotes/from-cart", { cartLines, target: { mode: "new", title: "Cart", neededBy: "2026-02-31" } });
      expect(r1.status).toBe(400);
      expect(await quoteCount()).toBe(0);
      const q = await draftWith(h, [{ variantId: V_COSTLY, qty: 1 }]);
      const r2 = await h.c.post("/c/quotes/from-cart", { cartLines, target: { mode: "existing", quoteId: q.id, neededBy: "2026-13-45" } });
      expect(r2.status).toBe(400);
      expect(await h.prisma.quoteLine.count({ where: { quoteId: q.id } })).toBe(1);
    });

    it("staff-created quotes do not accept a neededBy at all, so the staff routes cannot store a bad one either", async () => {
      await ensureStaff(h, STAFF_REP);
      const q = await submitted(h);
      const view = (await h.s.get(`/s/quotes/${q.id}`)).body;
      expect(view.neededBy).toBeNull();
    });
  });

  describe("2. draft-revision expiresAt with an absurd offset is a 4xx, never a 500", () => {
    async function working() {
      await ensureStaff(h, STAFF_REP);
      const q = await submitted(h);
      const line = (await h.s.post(`/s/quotes/${q.id}/claim`)).body.workingLines[0];
      const save = (expiresAt: unknown) =>
        h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: [{ id: line.id, variantId: line.variantId, qty: line.qty, quotedPrice: line.quotedPrice }], expiresAt });
      return { q, save };
    }

    it("+99:00, +24:00, +14:60, -99:00 and impossible calendar instants are 400; the stored expiry is untouched", async () => {
      const { q, save } = await working();
      const good = "2026-04-01T12:00:00+05:30";
      expect((await save(good)).status).toBe(200);
      for (const bad of ["2026-04-01T00:00:00+99:00", "2026-04-01T00:00:00-99:00", "2026-04-01T00:00:00+24:00", "2026-04-01T00:00:00+15:00", "2026-04-01T00:00:00+14:60", "2026-02-31T00:00:00Z", "2026-13-01T00:00:00Z", "2026-04-01T25:00:00Z", "not a date", 12345]) {
        const r = await save(bad);
        expect(r.status, String(bad)).toBe(400);
        expect(r.body.code).toBe("BAD_REQUEST");
      }
      const row = await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
      expect(row.workingExpiresAt?.toISOString()).toBe(new Date(good).toISOString());
    });

    it("real extreme offsets (+14:00, -12:00) and null still work", async () => {
      const { save } = await working();
      expect((await save("2026-04-01T00:00:00+14:00")).status).toBe(200);
      expect((await save("2026-04-01T00:00:00-12:00")).status).toBe(200);
      const cleared = await save(null);
      expect(cleared.status).toBe(200);
      expect(cleared.body.workingExpiresAt).toBeNull();
    });
  });

  describe("3. money and quantity overflow is a 422, never a 500", () => {
    const MAX = "9999999999.99"; // DECIMAL(12,2)

    async function working(lines = [{ variantId: V_GOOD, qty: 1 }]) {
      await ensureStaff(h, STAFF_REP);
      const q = await submitted(h, lines);
      const claimed = (await h.s.post(`/s/quotes/${q.id}/claim`)).body;
      const toLines = (price: string, qty = claimed.workingLines[0].qty) => [{ id: claimed.workingLines[0].id, variantId: claimed.workingLines[0].variantId, qty, quotedPrice: price }];
      return { q, claimed, toLines };
    }

    it("a quoted price wider than the column is 422 and nothing changes", async () => {
      const { q, toLines } = await working();
      for (const price of ["10000000000.00", "99999999999999999999.99", "9".repeat(60)]) {
        const r = await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: toLines(price) });
        expect(r.status, price).toBe(422);
        expect(r.body.code).toBe("VALIDATION_FAILED");
      }
      const line = await h.prisma.quoteLine.findFirstOrThrow({ where: { quoteId: q.id, set: "STAFF" } });
      expect(line.quotedPrice.toFixed(2)).toBe("50.00");
    });

    it("the maximum representable price with qty 1 is accepted, but qty x price over the maximum is 422 (subtotal / total guard)", async () => {
      const { q, toLines } = await working();
      const okRes = await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: toLines(MAX, 1) });
      expect(okRes.status).toBe(200);
      expect(okRes.body.total).toBe("50.00"); // the customer-visible total is still the request until send
      const over = await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: toLines(MAX, 2) });
      expect(over.status).toBe(422);
      const row = await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
      expect(row.status).toBe("IN_REVIEW");
      // Rolled back: the saved price from the previous successful call is intact.
      expect((await h.prisma.quoteLine.findFirstOrThrow({ where: { quoteId: q.id, set: "STAFF" } })).quotedPrice.toFixed(2)).toBe(MAX);
    });

    it("the SUM of several lines can overflow even when every line fits", async () => {
      const { q, claimed } = await working([{ variantId: V_GOOD, qty: 1 }, { variantId: V_COSTLY, qty: 1 }]);
      const lines = claimed.workingLines.map((l: any) => ({ id: l.id, variantId: l.variantId, qty: 1, quotedPrice: "6000000000.00" }));
      const r = await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines });
      expect(r.status).toBe(422);
      expect(r.body.code).toBe("VALIDATION_FAILED");
    });

    it("freight over the column is 422, and freight that pushes the TOTAL over the maximum is 422", async () => {
      const { q, toLines } = await working();
      expect((await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: toLines("1.00"), freight: "10000000000.00" })).status).toBe(422);
      expect((await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: toLines("5.00"), freight: MAX })).status).toBe(422);
      const fine = await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: toLines("5.00"), freight: "9999999990.00" });
      expect(fine.status).toBe(200);
      expect(fine.body.workingFreight).toBe("9999999990.00");
    });

    it("send re-checks the version totals (subtotal + freight) before writing them", async () => {
      const { q, toLines } = await working();
      // Saved separately each fits (qty 1 x 9,999,999,999.99 priced line; freight 0), then freight is bumped by a direct edit
      // to simulate rows written before the guard existed.
      await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: toLines(MAX, 1) });
      await h.prisma.quote.update({ where: { id: q.id }, data: { workingFreight: MAX } });
      await ensureStaff(h, "5002", { isManager: true });
      await h.asStaff("5002").post(`/s/quotes/${q.id}/approve-floor`, {});
      const r = await h.s.post(`/s/quotes/${q.id}/send`);
      expect(r.status).toBe(422);
      expect(await h.prisma.quoteVersion.count({ where: { quoteId: q.id } })).toBe(0);
      expect((await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("IN_REVIEW");
    });

    it("a very negative margin does not overflow the quote's marginPct column (clamped)", async () => {
      const { q, toLines } = await working([{ variantId: V_COSTLY, qty: 1 }]);
      const r = await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: toLines("0.01") }); // cost 90.00 -> margin -899,900%
      expect(r.status).toBe(200);
      expect(r.body.belowFloor).toBe(true);
      const row = await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
      expect(row.marginPct?.toFixed(2)).toBe("-99999.99");
    });

    it("customer side: a catalog price x quantity that overflows is 422 on add-line, patch-line and from-cart, and nothing is stored", async () => {
      h.shopify.addVariant({ variantId: "gid://shopify/ProductVariant/77", price: "99999999.00", unitCost: "1.00", title: "Gold bar" });
      const q = await draftWith(h, [{ variantId: V_GOOD, qty: 1 }]);
      const lineCount = () => h.prisma.quoteLine.count({ where: { quoteId: q.id } });

      const add = await h.c.post(`/c/quotes/${q.id}/lines`, { variantId: "gid://shopify/ProductVariant/77", qty: 100000 }); // ~9.99e12
      expect(add.status).toBe(422);
      expect(add.body.code).toBe("VALIDATION_FAILED");
      expect(await lineCount()).toBe(1);
      expect((await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).total.toFixed(2)).toBe("50.00");

      const ok = await h.c.post(`/c/quotes/${q.id}/lines`, { variantId: "gid://shopify/ProductVariant/77", qty: 50 }); // 4,999,999,950.00 fits
      expect(ok.status).toBe(201);
      const lineId = ok.body.lines.find((l: any) => l.variantId.endsWith("/77")).id;
      const patch = await h.c.patch(`/c/quotes/${q.id}/lines/${lineId}`, { qty: 100000 });
      expect(patch.status).toBe(422);
      expect((await h.prisma.quoteLine.findUniqueOrThrow({ where: { id: lineId } })).qty).toBe(50);

      const cart = await h.c.post("/c/quotes/from-cart", { cartLines: [{ variantId: "gid://shopify/ProductVariant/77", qty: 100000 }], target: { mode: "new", title: "Cart" } });
      expect(cart.status).toBe(422);
      expect(await quoteCount()).toBe(1); // the from-cart draft was rolled back
    });

    it("a catalog price or cost wider than the column is 422 (not a 500) when it is snapshotted", async () => {
      h.shopify.addVariant({ variantId: "gid://shopify/ProductVariant/78", price: "99999999999999.00", unitCost: "1.00", title: "Absurd price" });
      h.shopify.addVariant({ variantId: "gid://shopify/ProductVariant/79", price: "5.00", unitCost: "99999999999999.00", title: "Absurd cost" });
      const q = await draftWith(h);
      expect((await h.c.post(`/c/quotes/${q.id}/lines`, { variantId: "gid://shopify/ProductVariant/78", qty: 1 })).status).toBe(422);
      expect((await h.c.post(`/c/quotes/${q.id}/lines`, { variantId: "gid://shopify/ProductVariant/79", qty: 1 })).status).toBe(422);
      await ensureStaff(h, STAFF_REP);
      const sub = await submitted(h);
      await h.s.post(`/s/quotes/${sub.id}/claim`);
      const r = await h.s.put(`/s/quotes/${sub.id}/draft-revision`, { lines: [{ variantId: "gid://shopify/ProductVariant/78", qty: 1, quotedPrice: "1.00" }] });
      expect(r.status).toBe(422);
    });

    it("quantity limits stay a 400 (contract maximum 100000)", async () => {
      const q = await draftWith(h);
      expect((await h.c.post(`/c/quotes/${q.id}/lines`, { variantId: V_GOOD, qty: 100001 })).status).toBe(400);
      expect((await h.c.post(`/c/quotes/${q.id}/lines`, { variantId: V_GOOD, qty: 99999999999 })).status).toBe(400);
    });

    it("quote-number search cannot overflow the INT column (customer and staff)", async () => {
      await ensureStaff(h, STAFF_REP);
      await draftWith(h);
      expect((await h.c.get("/c/quotes?q=99999999999999")).status).toBe(200);
      expect((await h.s.get("/s/quotes?q=Q-99999999999999")).status).toBe(200);
      expect((await h.s.get("/s/quotes?q=2147483648")).status).toBe(200);
    });
  });

  describe("4. staff customer-visible message on a DRAFT is refused", () => {
    it("internal=false (explicit or default) on a DRAFT is 409 NOT_EDITABLE and writes nothing; internal notes are allowed", async () => {
      await ensureStaff(h, STAFF_REP);
      const q = await draftWith(h);
      const explicit = await h.s.post(`/s/quotes/${q.id}/messages`, { body: "Hello customer", internal: false });
      expect(explicit.status).toBe(409);
      expect(explicit.body).toMatchObject({ code: "NOT_EDITABLE", details: { status: "DRAFT" } });
      const implicit = await h.s.post(`/s/quotes/${q.id}/messages`, { body: "Hello again" });
      expect(implicit.status).toBe(409);
      expect(implicit.body.code).toBe("NOT_EDITABLE");
      expect(await h.prisma.message.count({ where: { quoteId: q.id } })).toBe(0);
      expect(await eventsOf(h, q.id, "NEW_MESSAGE")).toHaveLength(0);

      const note = await h.s.post(`/s/quotes/${q.id}/messages`, { body: "Internal heads-up", internal: true });
      expect(note.status).toBe(201);
      expect(note.body.internal).toBe(true);
      expect(await eventsOf(h, q.id, "NEW_MESSAGE")).toHaveLength(0); // still no customer notification
    });

    it("once the customer submits, the same call works", async () => {
      await ensureStaff(h, STAFF_REP);
      const q = await draftWith(h);
      expect((await h.s.post(`/s/quotes/${q.id}/messages`, { body: "too early", internal: false })).status).toBe(409);
      await h.c.post(`/c/quotes/${q.id}/submit`, {});
      const r = await h.s.post(`/s/quotes/${q.id}/messages`, { body: "Got it, working on it", internal: false });
      expect(r.status).toBe(201);
      expect(await eventsOf(h, q.id, "NEW_MESSAGE")).toHaveLength(1);
    });
  });
});
