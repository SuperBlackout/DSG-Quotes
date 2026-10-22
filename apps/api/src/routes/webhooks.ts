import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { verifyShopifyWebhook } from "../auth/crypto";
import type { AppDeps, Tx } from "../context";
import { refreshDerived } from "../domain/lines";
import { applyTransition, lockQuote, writeEvent } from "../domain/transitions";
import { ApiError } from "../errors";

type Json = Record<string, unknown>;

const QUOTE_TAG = /(?:^|[\s,])quote:Q-(\d+)(?:$|[\s,])/;

/**
 * Shopify webhooks. Configure every topic in shopify.app.toml with `uri = "/webhooks/shopify"`; the topic
 * comes from the X-Shopify-Topic header. The body is HMAC-verified against the raw bytes BEFORE parsing, and
 * redelivery is deduplicated by X-Shopify-Webhook-Id.
 */
export async function webhookRoutes(app: FastifyInstance) {
  const deps: AppDeps = app.deps;
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  app.post("/shopify", async (req, reply) => {
    const raw = req.body as Buffer;
    const h = req.headers;
    if (!verifyShopifyWebhook(raw, h["x-shopify-hmac-sha256"] as string | undefined, deps.config.apiSecret)) {
      throw new ApiError("UNAUTHENTICATED", "Invalid webhook signature");
    }
    if (h["x-shopify-shop-domain"] !== deps.config.shopDomain) throw new ApiError("UNAUTHENTICATED", "Unknown shop");
    const topic = String(h["x-shopify-topic"] ?? "");
    const webhookId = String(h["x-shopify-webhook-id"] ?? "");
    let payload: Json;
    try {
      payload = JSON.parse(raw.toString("utf8")) as Json;
    } catch {
      throw new ApiError("BAD_REQUEST", "Invalid JSON");
    }

    const result = await deps.prisma.$transaction(async (tx) => {
      if (webhookId) {
        if (await tx.webhookReceipt.findUnique({ where: { id: webhookId } })) return "duplicate";
        await tx.webhookReceipt.create({ data: { id: webhookId, topic } });
      }
      switch (topic) {
        case "orders/create":
          return handleOrderCreate(tx, deps, payload);
        case "draft_orders/update":
          return handleDraftOrderUpdate(tx, deps, payload);
        case "app/uninstalled":
          await tx.session.deleteMany({ where: { shop: deps.config.shopDomain } });
          return "uninstalled";
        case "customers/data_request":
          // No export is generated automatically; the receipt row is the audit trail. Fulfil manually (see report).
          return "data_request_logged";
        case "customers/redact":
          return handleCustomerRedact(tx, deps, payload);
        case "shop/redact":
          return handleShopRedact(tx, deps);
        default:
          return "ignored";
      }
    });
    // The contract documents a bare 200 (no body); the outcome is exposed as a header for logs and tests.
    return reply.status(200).header("x-webhook-result", result).send();
  });
}

const gid = (kind: string, id: unknown) => `gid://shopify/${kind}/${String(id)}`;

async function handleOrderCreate(tx: Tx, deps: AppDeps, o: Json): Promise<string> {
  const shop = deps.config.shopDomain;
  const orderGid = typeof o.admin_graphql_api_id === "string" ? o.admin_graphql_api_id : o.id != null ? gid("Order", o.id) : null;
  if (!orderGid) return "no_order_id";

  let candidate: { id: string } | null = null;
  if (o.draft_order_id != null) {
    candidate = await tx.quote.findFirst({ where: { shop, draftOrderId: gid("DraftOrder", o.draft_order_id) }, select: { id: true } });
  }
  if (!candidate) {
    const tags = typeof o.tags === "string" ? o.tags : Array.isArray(o.tags) ? o.tags.join(",") : "";
    const m = QUOTE_TAG.exec(tags);
    if (m) candidate = await tx.quote.findFirst({ where: { shop, number: Number(m[1]) }, select: { id: true } });
  }
  if (!candidate) return "no_matching_quote";

  const quote = await lockQuote(tx, candidate.id);
  if (!quote) return "no_matching_quote";
  if (quote.status === "ORDERED") return quote.orderId === orderGid ? "already_ordered" : "already_ordered_other_order";
  if (quote.status !== "ACCEPTED") {
    await writeEvent(tx, quote.id, "ORDER_IGNORED", "system", null, { orderId: orderGid, status: quote.status }, deps.now());
    return "ignored_status";
  }
  await applyTransition(tx, {
    quote,
    event: "ORDER_PLACED",
    actor: "system",
    actorId: null,
    now: deps.now(),
    payload: { orderId: orderGid },
    data: { orderId: orderGid },
  });
  await refreshDerived(tx, quote.id);
  return "ordered";
}

async function handleDraftOrderUpdate(tx: Tx, deps: AppDeps, d: Json): Promise<string> {
  const id = typeof d.admin_graphql_api_id === "string" ? d.admin_graphql_api_id : d.id != null ? gid("DraftOrder", d.id) : null;
  if (!id) return "no_id";
  const quote = await tx.quote.findFirst({ where: { shop: deps.config.shopDomain, draftOrderId: id } });
  if (!quote) return "no_matching_quote";
  await tx.quote.update({
    where: { id: quote.id },
    data: {
      draftOrderStatus: typeof d.status === "string" ? d.status : quote.draftOrderStatus,
      ...(d.order_id != null && !quote.orderId ? { orderId: gid("Order", d.order_id) } : {}),
    },
  });
  return "draft_order_synced";
}

async function handleCustomerRedact(tx: Tx, deps: AppDeps, p: Json): Promise<string> {
  const shop = deps.config.shopDomain;
  const cust = (p.customer ?? {}) as Json;
  if (cust.id == null) return "no_customer";
  const customerId = gid("Customer", cust.id);
  const quotes = await tx.quote.findMany({ where: { shop, customerId }, select: { id: true } });
  const ids = quotes.map((q) => q.id);
  if (ids.length) {
    await tx.quote.updateMany({
      where: { id: { in: ids } },
      data: { customerName: "Redacted", customerEmail: null, notesToSales: null, shipToAddress: Prisma.DbNull, watchers: [] },
    });
    await tx.message.updateMany({
      where: { quoteId: { in: ids }, authorType: "CUSTOMER" },
      data: { body: "[redacted]", authorName: null, attachments: [] },
    });
  }
  if (ids.length) await tx.quoteRecipient.deleteMany({ where: { quoteId: { in: ids } } });
  await tx.notificationPref.deleteMany({ where: { shop, customerId } });
  await tx.customerProfile.deleteMany({ where: { shop, customerId } });
  await tx.activeQuote.deleteMany({ where: { shop, customerId } });
  return "customer_redacted";
}

async function handleShopRedact(tx: Tx, deps: AppDeps): Promise<string> {
  const shop = deps.config.shopDomain;
  const ids = (await tx.quote.findMany({ where: { shop }, select: { id: true } })).map((q) => q.id);
  await tx.event.deleteMany({ where: { quoteId: { in: ids } } });
  await tx.quoteRecipient.deleteMany({ where: { quoteId: { in: ids } } });
  await tx.message.deleteMany({ where: { quoteId: { in: ids } } });
  await tx.quoteLine.deleteMany({ where: { quoteId: { in: ids } } });
  await tx.quoteVersion.deleteMany({ where: { quoteId: { in: ids } } });
  await tx.quote.deleteMany({ where: { shop } });
  await tx.job.deleteMany({ where: { shop } });
  await tx.notificationPref.deleteMany({ where: { shop } });
  await tx.customerProfile.deleteMany({ where: { shop } });
  await tx.activeQuote.deleteMany({ where: { shop } });
  await tx.counter.deleteMany({ where: { shop } });
  await tx.staff.deleteMany({ where: { shop } });
  await tx.session.deleteMany({ where: { shop } });
  return "shop_redacted";
}
