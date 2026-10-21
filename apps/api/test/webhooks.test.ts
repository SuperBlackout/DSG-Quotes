import { describe, expect, it } from "vitest";
import { signShopifyWebhook } from "../src/auth/crypto";
import { CUSTOMER_A, CUSTOMER_B, SECRET, SHOP, accepted, draftWith, eventsOf, sent, useHarness } from "./helpers";

describe("Shopify webhooks", () => {
  const h = useHarness();
  let seq = 0;

  const hook = (topic: string, payload: unknown, opts: { secret?: string; shop?: string; id?: string; raw?: string } = {}) => {
    const raw = opts.raw ?? JSON.stringify(payload);
    return h.raw({
      method: "POST",
      url: "/webhooks/shopify",
      headers: {
        "content-type": "application/json",
        "x-shopify-topic": topic,
        "x-shopify-shop-domain": opts.shop ?? SHOP,
        "x-shopify-webhook-id": opts.id ?? `wh-${++seq}`,
        "x-shopify-hmac-sha256": signShopifyWebhook(raw, opts.secret ?? SECRET),
      },
      payload: raw,
    });
  };

  const orderFor = (q: { number: number }, extra: object = {}) => ({
    id: 9001,
    admin_graphql_api_id: "gid://shopify/Order/9001",
    tags: `wholesale, quote:Q-${q.number}`,
    source_name: "shopify_draft_order",
    ...extra,
  });

  describe("orders/create", () => {
    it("matches the quote tag and moves ACCEPTED -> ORDERED (one event, orderId stored)", async () => {
      const q = await accepted(h);
      await h.c.post(`/c/quotes/${q.id}/checkout`);
      const r = await hook("orders/create", orderFor(q));
      expect(r.status).toBe(200);
      expect(r.headers["x-webhook-result"]).toBe("ordered");
      const row = await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
      expect(row).toMatchObject({ status: "ORDERED", orderId: "gid://shopify/Order/9001" });
      const ev = await eventsOf(h, q.id, "ORDER_PLACED");
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ actorType: "SYSTEM" });
      expect(ev[0]!.payload).toMatchObject({ from: "ACCEPTED", to: "ORDERED", orderId: "gid://shopify/Order/9001" });
      const view = (await h.c.get(`/c/quotes/${q.id}`)).body;
      expect(view).toMatchObject({ status: "ORDERED", orderId: "gid://shopify/Order/9001" });
      expect(view.actions.canBuy).toBe(false);
    });

    it("also matches by draft order id when the payload carries it", async () => {
      const q = await accepted(h);
      const co = (await h.c.post(`/c/quotes/${q.id}/checkout`)).body;
      const num = co.draftOrderId.split("/").pop();
      const r = await hook("orders/create", { id: 77, draft_order_id: Number(num), tags: "" });
      expect(r.headers["x-webhook-result"]).toBe("ordered");
      expect((await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).orderId).toBe("gid://shopify/Order/77");
    });

    it("is idempotent for redelivery (same webhook id and a fresh id for the same order)", async () => {
      const q = await accepted(h);
      expect((await hook("orders/create", orderFor(q), { id: "same" })).headers["x-webhook-result"]).toBe("ordered");
      expect((await hook("orders/create", orderFor(q), { id: "same" })).headers["x-webhook-result"]).toBe("duplicate");
      expect((await hook("orders/create", orderFor(q), { id: "other-delivery" })).headers["x-webhook-result"]).toBe("already_ordered");
      expect(await eventsOf(h, q.id, "ORDER_PLACED")).toHaveLength(1);
    });

    it("never orders a quote that is not ACCEPTED, and records the ignored delivery", async () => {
      const q = await sent(h); // QUOTE_READY
      const r = await hook("orders/create", orderFor(q));
      expect(r.status).toBe(200);
      expect(r.headers["x-webhook-result"]).toBe("ignored_status");
      expect((await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("QUOTE_READY");
      expect(await eventsOf(h, q.id, "ORDER_PLACED")).toHaveLength(0);
      expect(await eventsOf(h, q.id, "ORDER_IGNORED")).toHaveLength(1);
    });

    it("acknowledges orders that match no quote (ordinary web orders)", async () => {
      const r = await hook("orders/create", { id: 5, admin_graphql_api_id: "gid://shopify/Order/5", tags: "vip" });
      expect(r.status).toBe(200);
      expect(r.headers["x-webhook-result"]).toBe("no_matching_quote");
      expect((await hook("orders/create", { tags: "quote:Q-99999", id: 6 })).headers["x-webhook-result"]).toBe("no_matching_quote");
    });

    it("rejects a bad signature, a tampered body, a wrong shop; processes nothing", async () => {
      const q = await accepted(h);
      expect((await hook("orders/create", orderFor(q), { secret: "wrong" })).status).toBe(401);
      expect((await hook("orders/create", orderFor(q), { shop: "evil.myshopify.com" })).status).toBe(401);
      const raw = JSON.stringify(orderFor(q));
      const tampered = await h.raw({
        method: "POST",
        url: "/webhooks/shopify",
        headers: { "content-type": "application/json", "x-shopify-topic": "orders/create", "x-shopify-shop-domain": SHOP, "x-shopify-hmac-sha256": signShopifyWebhook(raw, SECRET) },
        payload: raw.replace("9001", "9002"),
      });
      expect(tampered.status).toBe(401);
      const noSig = await h.raw({ method: "POST", url: "/webhooks/shopify", headers: { "content-type": "application/json", "x-shopify-topic": "orders/create", "x-shopify-shop-domain": SHOP }, payload: raw });
      expect(noSig.status).toBe(401);
      expect((await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("ACCEPTED");
      expect(await h.prisma.webhookReceipt.count()).toBe(0);
    });

    it("signed but invalid JSON is a 400", async () => {
      expect((await hook("orders/create", null, { raw: "{broken" })).status).toBe(400);
    });
  });

  describe("draft_orders/update", () => {
    it("records the draft order status and links the order once completed (status change stays with orders/create)", async () => {
      const q = await accepted(h);
      const co = (await h.c.post(`/c/quotes/${q.id}/checkout`)).body;
      expect((await hook("draft_orders/update", { admin_graphql_api_id: co.draftOrderId, status: "invoice_sent" })).headers["x-webhook-result"]).toBe("draft_order_synced");
      expect((await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).draftOrderStatus).toBe("invoice_sent");
      await hook("draft_orders/update", { admin_graphql_api_id: co.draftOrderId, status: "completed", order_id: 4242 });
      const row = await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
      expect(row).toMatchObject({ draftOrderStatus: "completed", orderId: "gid://shopify/Order/4242", status: "ACCEPTED" });
    });

    it("ignores unknown draft orders", async () => {
      expect((await hook("draft_orders/update", { admin_graphql_api_id: "gid://shopify/DraftOrder/1", status: "open" })).headers["x-webhook-result"]).toBe("no_matching_quote");
    });
  });

  describe("app/uninstalled and compliance topics", () => {
    it("app/uninstalled deletes the stored sessions", async () => {
      await h.prisma.session.create({ data: { id: "offline_x", shop: SHOP, state: "s", accessToken: "tok" } });
      expect((await hook("app/uninstalled", {})).headers["x-webhook-result"]).toBe("uninstalled");
      expect(await h.prisma.session.count()).toBe(0);
    });

    it("customers/data_request is acknowledged and logged (no automatic export)", async () => {
      const r = await hook("customers/data_request", { customer: { id: 1001 } }, { id: "dr-1" });
      expect(r.status).toBe(200);
      expect(r.headers["x-webhook-result"]).toBe("data_request_logged");
      expect(await h.prisma.webhookReceipt.findUnique({ where: { id: "dr-1" } })).toMatchObject({ topic: "customers/data_request" });
    });

    it("customers/redact scrubs that customer's personal data but keeps other customers' data", async () => {
      const mine = await draftWith(h);
      await h.c.patch(`/c/quotes/${mine.id}`, { notesToSales: "call me", watchers: ["x@example.test"], shipTo: { name: "Dana", city: "Chicago" } });
      await h.c.post(`/c/quotes/${mine.id}/submit`, {});
      await h.c.post(`/c/quotes/${mine.id}/messages`, { body: "my phone is 555-0100" });
      await h.c.put("/c/notification-prefs", { events: { QUOTE_READY: { email: true, sms: false } }, email: "dana@example.test" });
      await h.c.put("/c/active-quote", { quoteId: null });
      const other = await draftWith(h, undefined, h.asCustomer(CUSTOMER_B));

      const r = await hook("customers/redact", { shop_domain: SHOP, customer: { id: Number(CUSTOMER_A.split("/").pop()) }, orders_to_redact: [] });
      expect(r.headers["x-webhook-result"]).toBe("customer_redacted");
      const row = await h.prisma.quote.findUniqueOrThrow({ where: { id: mine.id } });
      expect(row).toMatchObject({ customerName: "Redacted", customerEmail: null, notesToSales: null });
      expect(row.shipToAddress).toBeNull();
      expect(row.watchers).toEqual([]);
      expect((await h.prisma.message.findFirstOrThrow({ where: { quoteId: mine.id } })).body).toBe("[redacted]");
      expect(await h.prisma.notificationPref.count({ where: { customerId: CUSTOMER_A } })).toBe(0);
      expect(await h.prisma.customerProfile.count({ where: { customerId: CUSTOMER_A } })).toBe(0);
      expect((await h.prisma.quote.findUniqueOrThrow({ where: { id: other.id } })).customerName).toBe("Bea Buyer");
    });

    it("shop/redact erases every row for the shop", async () => {
      await accepted(h);
      await h.c.put("/c/notification-prefs", { events: { QUOTE_READY: { email: true, sms: false } }, email: "d@example.test" });
      const r = await hook("shop/redact", { shop_domain: SHOP });
      expect(r.headers["x-webhook-result"]).toBe("shop_redacted");
      for (const model of ["quote", "quoteLine", "quoteVersion", "message", "event", "job", "notificationPref", "customerProfile", "staff", "counter"] as const) {
        expect(await (h.prisma[model] as any).count(), model).toBe(0);
      }
    });

    it("unknown topics are acknowledged and ignored", async () => {
      expect((await hook("products/update", { id: 1 })).headers["x-webhook-result"]).toBe("ignored");
    });
  });
});
