/**
 * REGRESSIONS for the four apps/api bugs QA found in the first pass. They used to be `it.fails` (green while the bug existed);
 * the backend fixed them in contract 0.2.0, so they are ordinary tests now and go red if the bug comes back.
 *
 *   BUG-1  neededBy must be a real calendar date            -> 400 BAD_REQUEST, nothing stored
 *   BUG-2  draft-revision expiresAt with an absurd offset   -> 400 BAD_REQUEST, nothing stored
 *   BUG-3  money / quantity beyond the DB column width      -> 422 VALIDATION_FAILED (never 500)
 *   BUG-4  staff customer-visible message on a DRAFT        -> 409 NOT_EDITABLE (internal notes still allowed)
 *
 * (File name kept so existing references to it stay valid.) If you find a NEW backend bug, add it here as `it.fails`
 * with the exact failing request, and flip it when the backend fixes it.
 */
import { describe, expect, it } from "vitest";
import { claimAndPrice, draftWith, ok, submitted } from "./support/flows";
import * as F from "./support/fixtures";
import { useWorld } from "./support/world";

describe("QA regressions (apps/api)", () => {
  const w = useWorld();

  describe("BUG-1 neededBy is a real calendar date", () => {
    it("POST /c/quotes rejects impossible dates with 400 and creates no quote", async () => {
      for (const neededBy of ["2026-13-45", "2026-02-31", "2026-04-31", "2026-00-10", "2026-02-29"]) {
        const r = await w.dana.post("/c/quotes", { title: "x", neededBy }, { loose: true });
        expect(r.status, `${neededBy}: ${r.text}`).toBe(400);
        expect(r.body.code, neededBy).toBe("BAD_REQUEST");
      }
      expect(await w.prisma.quote.count()).toBe(0);
    });

    it("a real leap day is accepted and round-trips", async () => {
      const r = await w.dana.post("/c/quotes", { title: "leap", neededBy: "2028-02-29" });
      expect(ok(r, 201, "create").neededBy).toBe("2028-02-29");
    });

    it("PATCH /c/quotes/:id rejects it and keeps the stored value; null clears it", async () => {
      const q = await draftWith(w.dana);
      expect(ok(await w.dana.patch(`/c/quotes/${q.id}`, { neededBy: "2026-05-01" }), 200, "set").neededBy).toBe("2026-05-01");
      for (const neededBy of ["2026-02-31", "2026-13-45"]) {
        const r = await w.dana.patch(`/c/quotes/${q.id}`, { neededBy }, { loose: true });
        expect(r.status, neededBy).toBe(400);
      }
      expect(ok(await w.dana.get(`/c/quotes/${q.id}`), 200, "get").neededBy).toBe("2026-05-01");
      expect(ok(await w.dana.patch(`/c/quotes/${q.id}`, { neededBy: null }), 200, "clear").neededBy).toBeNull();
    });

    it("submit and from-cart reject it and change nothing", async () => {
      const q = await draftWith(w.dana);
      const bad = await w.dana.post(`/c/quotes/${q.id}/submit`, { neededBy: "2026-02-31" }, { loose: true });
      expect(bad.status).toBe(400);
      expect(ok(await w.dana.get(`/c/quotes/${q.id}`), 200, "still draft").status).toBe("DRAFT");
      const before = await w.prisma.quote.count();
      const cart = await w.dana.post(
        "/c/quotes/from-cart",
        { cartLines: [{ variantId: F.V_PIPE, qty: 1 }], target: { mode: "new", title: "Cart", neededBy: "2026-13-45" } },
        { loose: true },
      );
      expect(cart.status).toBe(400);
      expect(await w.prisma.quote.count()).toBe(before);
    });
  });

  describe("BUG-2 draft-revision expiresAt with an absurd offset", () => {
    it("+99:00, -99:00, +24:00 and impossible instants are 400; the stored working expiry is untouched", async () => {
      const q = await submitted(w.dana);
      const claimed = await claimAndPrice(w.rep1, q.id);
      const line = claimed.workingLines[0];
      const save = (expiresAt: unknown, o: { loose?: boolean } = { loose: true }) =>
        w.rep1.put(`/s/quotes/${q.id}/draft-revision`, { lines: [{ id: line.id, variantId: line.variantId, qty: line.qty, quotedPrice: line.quotedPrice }], expiresAt }, o);
      const good = "2026-03-20T12:00:00+05:30";
      expect((await save(good, {})).status).toBe(200);
      for (const bad of ["2026-03-05T00:00:00+99:00", "2026-03-05T00:00:00-99:00", "2026-03-05T00:00:00+24:00", "2026-02-31T00:00:00Z", "2026-03-05T25:00:00Z", "not a date"]) {
        const r = await save(bad);
        expect(r.status, bad).toBe(400);
        expect(r.body.code, bad).toBe("BAD_REQUEST");
      }
      const view = ok(await w.rep1.get(`/s/quotes/${q.id}`), 200, "view");
      expect(new Date(view.workingExpiresAt).toISOString()).toBe(new Date(good).toISOString());
      // Real extreme offsets still work, and null clears it.
      expect((await save("2026-03-20T00:00:00+14:00", {})).status).toBe(200);
      expect((await save(null, {})).body.workingExpiresAt).toBeNull();
    });
  });

  describe("BUG-3 money and quantity overflow is a 422, never a 500", () => {
    it("quotedPrice 99999999999999.99 and freight beyond DECIMAL(12,2) -> 422 VALIDATION_FAILED, nothing saved", async () => {
      const q = await submitted(w.dana);
      const claimed = await claimAndPrice(w.rep1, q.id);
      const line = claimed.workingLines[0];
      const put = (body: object) => w.rep1.put(`/s/quotes/${q.id}/draft-revision`, body, { loose: true });
      const mine = { id: line.id, variantId: line.variantId, qty: line.qty };
      const price = await put({ lines: [{ ...mine, quotedPrice: "99999999999999.99" }] });
      expect(price.status, price.text).toBe(422);
      expect(price.body.code).toBe("VALIDATION_FAILED");
      const freight = await put({ lines: [{ ...mine, quotedPrice: line.quotedPrice }], freight: "99999999999999.99" });
      expect(freight.status, freight.text).toBe(422);
      expect(freight.body.code).toBe("VALIDATION_FAILED");
      expect(ok(await w.rep1.get(`/s/quotes/${q.id}`), 200, "view").workingLines[0].quotedPrice).toBe(line.quotedPrice);
    });

    it("the largest legal price is accepted; one over the line total limit is refused at send", async () => {
      const q = await submitted(w.dana, [{ variantId: F.V_VALVE, qty: 1 }]);
      const claimed = await claimAndPrice(w.rep1, q.id);
      const line = claimed.workingLines[0];
      const mine = { id: line.id, variantId: line.variantId };
      const edge = await w.rep1.put(`/s/quotes/${q.id}/draft-revision`, { lines: [{ ...mine, qty: 100000, quotedPrice: "9999999999.99" }] }, { loose: true });
      // 100000 x 9,999,999,999.99 overflows a DECIMAL(12,2) total: it must be a clean 422 somewhere in the save/send path, never a 500.
      if (edge.status === 200) {
        const sent = await w.rep1.post(`/s/quotes/${q.id}/send`);
        expect(sent.status, sent.text).toBe(422);
      } else {
        expect(edge.status, edge.text).toBe(422);
      }
    });

    it("an absurd quantity on a customer line is a 4xx, never a 500", async () => {
      const d = await draftWith(w.dana, []);
      for (const qty of [1e12, 2147483648, 100001]) {
        const r = await w.dana.post(`/c/quotes/${d.id}/lines`, { variantId: F.V_PIPE, qty }, { loose: true });
        expect(r.status, `qty ${qty}: ${r.text}`).toBeGreaterThanOrEqual(400);
        expect(r.status, `qty ${qty}`).toBeLessThan(500);
      }
    });
  });

  describe("BUG-4 staff cannot post a customer-visible message on a customer's private DRAFT", () => {
    it("internal=false -> 409 NOT_EDITABLE and no message or NEW_MESSAGE event; an internal note is still fine", async () => {
      const d = await draftWith(w.dana);
      const r = await w.rep1.post(`/s/quotes/${d.id}/messages`, { body: "hi" });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("NOT_EDITABLE");
      const r2 = await w.rep1.post(`/s/quotes/${d.id}/messages`, { body: "hi", internal: false });
      expect(r2.status).toBe(409);
      expect(await w.prisma.message.count({ where: { quoteId: d.id } })).toBe(0);
      expect(await w.prisma.event.count({ where: { quoteId: d.id, type: "NEW_MESSAGE" } })).toBe(0);
      ok(await w.rep1.post(`/s/quotes/${d.id}/messages`, { body: "note to self", internal: true }), 201, "internal note on a draft");
      // Once the dealer submits, a visible reply is allowed.
      ok(await w.dana.post(`/c/quotes/${d.id}/submit`, {}), 200, "submit");
      ok(await w.rep1.post(`/s/quotes/${d.id}/messages`, { body: "Got it" }), 201, "visible reply after submit");
    });
  });
});
