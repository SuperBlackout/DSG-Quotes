import { describe, expect, it } from "vitest";
import { isPurchasable, type QuoteStatus } from "shared";
import { ShopifyUserError } from "../src/shopify/types";
import { CUSTOMER_A, CUSTOMER_B, LOC1, STAFF_MANAGER, STAFF_REP, V_GOOD, V_NOCOST, accepted, draftWith, ensureStaff, eventsOf, sent, submitted, useHarness } from "./helpers";

describe("accept -> buy (checkout)", () => {
  const h = useHarness();
  const DAY = 24 * 3600 * 1000;

  it("creates a draft order from the frozen version: priceOverride at quotedPrice, freight, tag, PO, company purchasing entity", async () => {
    await ensureStaff(h, STAFF_REP);
    const q = await submitted(h, [{ variantId: V_GOOD, qty: 3 }, { variantId: V_NOCOST, qty: 5 }]);
    await h.s.post(`/s/quotes/${q.id}/claim`);
    const lines = (await h.s.get(`/s/quotes/${q.id}`)).body.workingLines;
    await h.s.put(`/s/quotes/${q.id}/draft-revision`, {
      lines: lines.map((l: any) => ({ id: l.id, variantId: l.variantId, qty: l.qty, quotedPrice: l.variantId === V_GOOD ? "41.25" : "9.00" })),
      freight: "30.00",
      repNote: "Ships in 5 days",
    });
    // The no-cost line can never be margin-checked, so a manager has to approve it before it can be sent.
    await ensureStaff(h, STAFF_MANAGER, { isManager: true });
    expect((await h.asStaff(STAFF_MANAGER).post(`/s/quotes/${q.id}/approve-floor`, {})).status).toBe(200);
    expect((await h.s.post(`/s/quotes/${q.id}/send`)).status).toBe(200);
    await h.c.post(`/c/quotes/${q.id}/accept`, { versionNo: 1 });

    const r = await h.c.post(`/c/quotes/${q.id}/checkout`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ invoiceUrl: expect.stringMatching(/^https:\/\//), draftOrderId: expect.stringMatching(/^gid:\/\/shopify\/DraftOrder\//) });

    expect(h.shopify.createdDraftOrders).toHaveLength(1);
    const { input } = h.shopify.createdDraftOrders[0]!;
    expect(input).toMatchObject({
      quoteLabel: `Q-${q.number}`,
      currencyCode: "USD",
      customerId: CUSTOMER_A,
      companyId: "gid://shopify/Company/1",
      companyLocationId: LOC1,
      companyContactId: "gid://shopify/CompanyContact/1001",
      freight: "30.00",
      poNumber: "PO-1",
      tags: [`quote:Q-${q.number}`],
      paymentTermsTemplateId: null,
    });
    expect(input.lines).toEqual([
      { variantId: V_GOOD, quantity: 3, priceOverride: "41.25" },
      { variantId: V_NOCOST, quantity: 5, priceOverride: "9.00" },
    ]);
    expect(input.note).toContain(`Quote Q-${q.number} v1`);
    expect(input.note).toContain("Job: Job One");
    expect(input.note).toContain("Ships in 5 days");

    const row = await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
    expect(row).toMatchObject({ draftOrderId: r.body.draftOrderId, draftOrderInvoiceUrl: r.body.invoiceUrl, draftOrderVersion: 1, status: "ACCEPTED" });
    expect(await eventsOf(h, q.id, "CHECKOUT")).toHaveLength(1);
  });

  it("is idempotent: repeated and concurrent clicks reuse one draft order", async () => {
    const q = await accepted(h);
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => h.c.post(`/c/quotes/${q.id}/checkout`)));
    const again = await h.c.post(`/c/quotes/${q.id}/checkout`);
    for (const r of [a!, b!, c!, again]) expect(r.status).toBe(200);
    expect(new Set([a!, b!, c!, again].map((r) => r.body.draftOrderId)).size).toBe(1);
    expect(h.shopify.createdDraftOrders).toHaveLength(1);
    expect(await eventsOf(h, q.id, "CHECKOUT")).toHaveLength(1);
  });

  it("recreates the draft order only after a reopen + new version", async () => {
    const q = await accepted(h);
    const first = (await h.c.post(`/c/quotes/${q.id}/checkout`)).body;
    expect((await h.c.post(`/c/quotes/${q.id}/reopen`)).status).toBe(200);
    expect(h.shopify.deletedDraftOrders).toEqual([first.draftOrderId]);
    // Not purchasable while reopened.
    const blocked = await h.c.post(`/c/quotes/${q.id}/checkout`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("NOT_PURCHASABLE");

    await ensureStaff(h, STAFF_REP);
    await h.s.post(`/s/quotes/${q.id}/claim`);
    const line = (await h.s.get(`/s/quotes/${q.id}`)).body.workingLines[0];
    await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: [{ id: line.id, variantId: line.variantId, qty: line.qty, quotedPrice: "40.00" }] });
    await h.s.post(`/s/quotes/${q.id}/send`);
    await h.c.post(`/c/quotes/${q.id}/accept`, { versionNo: 2 });
    const second = (await h.c.post(`/c/quotes/${q.id}/checkout`)).body;
    expect(second.draftOrderId).not.toBe(first.draftOrderId);
    expect(h.shopify.createdDraftOrders).toHaveLength(2);
    expect(h.shopify.createdDraftOrders[1]!.input.lines[0]!.priceOverride).toBe("40.00");
  });

  describe("purchase guard (isPurchasable re-checked server side)", () => {
    const statuses: QuoteStatus[] = ["DRAFT", "SUBMITTED", "IN_REVIEW", "QUOTE_READY", "CHANGES_REQUESTED", "ORDERED", "EXPIRED", "DECLINED"];
    for (const status of statuses) {
      it(`refuses ${status} with 409 NOT_PURCHASABLE and never calls Shopify`, async () => {
        // Build a quote in the target status by driving the real API.
        let id: string;
        switch (status) {
          case "DRAFT":
            id = (await draftWith(h)).id;
            break;
          case "SUBMITTED":
            id = (await submitted(h)).id;
            break;
          case "IN_REVIEW": {
            id = (await submitted(h)).id;
            await ensureStaff(h, STAFF_REP);
            await h.s.post(`/s/quotes/${id}/claim`);
            break;
          }
          case "QUOTE_READY":
            id = (await sent(h)).id;
            break;
          case "CHANGES_REQUESTED":
            id = (await sent(h)).id;
            await h.c.post(`/c/quotes/${id}/request-changes`, { message: "x" });
            break;
          case "DECLINED":
            id = (await sent(h)).id;
            await h.c.post(`/c/quotes/${id}/decline`, {});
            break;
          case "EXPIRED":
            id = (await sent(h)).id;
            h.clock.now = new Date(h.clock.now.getTime() + 15 * DAY);
            await h.c.post(`/c/quotes/${id}/accept`, {}); // lazily expires
            break;
          case "ORDERED":
            id = (await accepted(h)).id;
            await h.prisma.$transaction(async (tx) => {
              // Reach ORDERED legitimately via the webhook path elsewhere; here use the shared transition.
              const { applyTransition } = await import("../src/domain/transitions");
              const quote = await tx.quote.findUniqueOrThrow({ where: { id } });
              await applyTransition(tx, { quote, event: "ORDER_PLACED", actor: "system", actorId: null, now: h.clock.now });
            });
            break;
          default:
            throw new Error("unhandled");
        }
        expect((await h.prisma.quote.findUniqueOrThrow({ where: { id } })).status).toBe(status);
        const r = await h.c.post(`/c/quotes/${id}/checkout`);
        expect(r.status).toBe(409);
        expect(r.body.code).toBe("NOT_PURCHASABLE");
        expect(h.shopify.createdDraftOrders).toHaveLength(0);
        // The server's answer agrees with the shared guard.
        expect(isPurchasable(status, null)).toBe(false);
        const view = await h.c.get(`/c/quotes/${id}`);
        expect(view.body.actions.canBuy).toBe(false);
      });
    }

    it("an ACCEPTED quote past its expiry is expired on the spot instead of purchased", async () => {
      const q = await accepted(h);
      h.clock.now = new Date(h.clock.now.getTime() + 15 * DAY);
      expect((await h.c.get(`/c/quotes/${q.id}`)).body.actions.canBuy).toBe(false);
      const r = await h.c.post(`/c/quotes/${q.id}/checkout`);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("NOT_PURCHASABLE");
      expect(r.body.details).toMatchObject({ status: "EXPIRED" });
      expect(h.shopify.createdDraftOrders).toHaveLength(0);
      expect((await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("EXPIRED");
      expect(await eventsOf(h, q.id, "EXPIRE")).toHaveLength(1);
    });

    it("canBuy flips exactly at the expiry boundary", async () => {
      const q = await accepted(h);
      const exp = new Date((await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).expiresAt!);
      h.clock.now = new Date(exp.getTime() - 1000);
      expect((await h.c.get(`/c/quotes/${q.id}`)).body.actions.canBuy).toBe(true);
      h.clock.now = exp;
      expect((await h.c.get(`/c/quotes/${q.id}`)).body.actions.canBuy).toBe(false);
    });
  });

  it("net-terms location: completes the draft order with payment pending and returns the order status URL", async () => {
    h.shopify.buyers.get(CUSTOMER_A)!.paymentTermsTemplateId = "gid://shopify/PaymentTermsTemplate/4";
    const q = await accepted(h);
    const r = await h.c.post(`/c/quotes/${q.id}/checkout`);
    expect(r.status).toBe(200);
    expect(h.shopify.createdDraftOrders[0]!.input.paymentTermsTemplateId).toBe("gid://shopify/PaymentTermsTemplate/4");
    expect(h.shopify.completedDraftOrders).toEqual([r.body.draftOrderId]);
    expect(r.body.invoiceUrl).toContain("/orders/");
  });

  it("a Shopify failure stores nothing and the next click retries cleanly", async () => {
    const q = await accepted(h);
    h.shopify.failNextCreate = new Error("boom");
    const bad = await h.c.post(`/c/quotes/${q.id}/checkout`);
    expect(bad.status).toBe(500);
    expect(bad.body.code).toBe("INTERNAL");
    expect(bad.text).not.toContain("boom");
    expect((await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).draftOrderId).toBeNull();

    h.shopify.failNextCreate = new ShopifyUserError("bad address", [{ message: "bad address" }]);
    const user = await h.c.post(`/c/quotes/${q.id}/checkout`);
    expect(user.status).toBe(422);
    expect(user.body.code).toBe("VALIDATION_FAILED");

    expect((await h.c.post(`/c/quotes/${q.id}/checkout`)).status).toBe(200);
    expect(h.shopify.createdDraftOrders).toHaveLength(1);
  });

  it("a colleague at the same location can buy (their contact is the purchasing entity); another company gets 404", async () => {
    const q = await accepted(h);
    const colleague = h.asCustomer("gid://shopify/Customer/1002");
    const r = await colleague.post(`/c/quotes/${q.id}/checkout`);
    expect(r.status).toBe(200);
    expect(h.shopify.createdDraftOrders[0]!.input.companyContactId).toBe("gid://shopify/CompanyContact/1002");
    expect((await h.asCustomer(CUSTOMER_B).post(`/c/quotes/${q.id}/checkout`)).status).toBe(404);
  });
});
