import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import type { QuoteEvent } from "shared";
import { z } from "zod";
import { customerAuth } from "../auth/middleware";
import type { AppDeps, Tx } from "../context";
import { checkoutQuote } from "../domain/checkout";
import {
  MESSAGE_PAGE,
  addLine,
  createDraft,
  fetchPricing,
  getScopedQuote,
  loadCustomerView,
  resolveJob,
  scopeWhere,
  setActiveQuote,
} from "../domain/customerQuotes";
import { customerLines, customerVisibleLines, materializeStaffSet, refreshDerived } from "../domain/lines";
import { applyTransition, writeEvent } from "../domain/transitions";
import { ApiError, notFound } from "../errors";
import { page, parse } from "../http";
import { asAttachments, customerMessage, customerSummary } from "../serializers/customer";
import type { BuyerContext } from "../shopify/types";
import { registerPrefsRoutes } from "./customerPrefs";

// ---------------------------------------------------------------- request schemas (mirror docs/openapi.yaml)
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const newJob = z.object({ name: z.string().min(1).max(200), poNumber: z.string().max(100).optional(), siteAddress: z.string().max(500).optional() });
const address = z
  .object({
    name: z.string(),
    company: z.string(),
    address1: z.string(),
    address2: z.string().nullable(),
    city: z.string(),
    province: z.string(),
    zip: z.string(),
    country: z.string(),
    phone: z.string().nullable(),
  })
  .partial();
const email = z.string().email();

const createQuoteBody = z.object({
  title: z.string().min(1).max(200),
  jobId: z.string().optional(),
  newJob: newJob.optional(),
  poNumber: z.string().max(100).optional(),
  neededBy: dateStr.optional(),
  setActive: z.boolean().default(true),
});
const updateQuoteBody = z
  .object({
    title: z.string().min(1).max(200),
    jobId: z.string().nullable(),
    newJob,
    poNumber: z.string().max(100).nullable(),
    neededBy: dateStr.nullable(),
    shipTo: address.nullable(),
    notesToSales: z.string().max(5000).nullable(),
    watchers: z.array(email).max(20),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, "At least one field is required");
const addLineBody = z.object({ variantId: z.string().min(1), qty: z.number().int().min(1).max(100000), lineNote: z.string().max(1000).optional() });
const updateLineBody = z
  .object({ qty: z.number().int().min(1).max(100000), lineNote: z.string().max(1000).nullable() })
  .partial()
  .refine((o) => Object.keys(o).length > 0, "At least one field is required");
const fromCartBody = z.object({
  cartLines: z.array(z.object({ variantId: z.string().min(1), qty: z.number().int().min(1).max(100000) })).min(1),
  target: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("new"),
      title: z.string().min(1).max(200),
      jobId: z.string().optional(),
      newJob: newJob.optional(),
      poNumber: z.string().max(100).optional(),
      neededBy: dateStr.optional(),
      notesToSales: z.string().max(5000).optional(),
    }),
    z.object({ mode: z.literal("existing"), quoteId: z.string().min(1) }),
  ]),
  submit: z.boolean().default(false),
  emptyCart: z.boolean().default(false),
});
const submitBody = z.object({ notesToSales: z.string().max(5000).optional(), neededBy: dateStr.optional(), poNumber: z.string().max(100).optional() });
const acceptBody = z.object({ versionNo: z.number().int().optional() });
const requestChangesBody = z.object({ message: z.string().min(1).max(5000) });
const declineBody = z.object({ reason: z.string().max(2000).optional() });
const postMessageBody = z.object({
  body: z.string().min(1).max(10000),
  attachments: z.array(z.object({ url: z.string().url(), name: z.string(), size: z.number().int(), mime: z.string() })).max(10).optional(),
});
const uploadUrlBody = z.object({ name: z.string().min(1).max(255), size: z.number().int().min(1).max(26214400), mime: z.string().min(1).max(200) });
const listQuery = z.object({
  status: z.enum(["DRAFT", "SUBMITTED", "IN_REVIEW", "QUOTE_READY", "CHANGES_REQUESTED", "ACCEPTED", "ORDERED", "EXPIRED", "DECLINED", "ARCHIVED"]).optional(),
  jobId: z.string().optional(),
  q: z.string().max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
const pageQuery = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(25) });
const activeBody = z.object({ quoteId: z.string().nullable() });

const buyerOf = (req: { customer?: { buyer: BuyerContext } }): BuyerContext => req.customer!.buyer;

// ---------------------------------------------------------------- shared flows
interface RunOptions {
  event: QuoteEvent;
  payload?: Record<string, unknown>;
  data?: (quote: Prisma.QuoteGetPayload<object>) => Omit<Prisma.QuoteUpdateInput, "status" | "statusChangedAt">;
  /** Runs after the quote is locked and before the transition. Return an ApiError to commit pending writes and then fail. */
  pre?: (tx: Tx, quote: Prisma.QuoteGetPayload<object>) => Promise<ApiError | void>;
  post?: (tx: Tx, quote: Prisma.QuoteGetPayload<object>) => Promise<void>;
  afterCommit?: (quote: Prisma.QuoteGetPayload<object>) => Promise<void>;
}

async function runCustomerTransition(deps: AppDeps, buyer: BuyerContext, id: string, o: RunOptions) {
  let failure: ApiError | undefined;
  let before: Prisma.QuoteGetPayload<object> | undefined;
  const view = await deps.prisma.$transaction(async (tx) => {
    const quote = await getScopedQuote(tx, deps, buyer, id, true);
    before = quote;
    const abort = await o.pre?.(tx, quote);
    if (abort) {
      failure = abort;
      return null;
    }
    await applyTransition(tx, {
      quote,
      event: o.event,
      actor: "customer",
      actorId: buyer.customerId,
      payload: o.payload,
      data: o.data?.(quote),
      now: deps.now(),
    });
    await o.post?.(tx, quote);
    await refreshDerived(tx, id);
    return loadCustomerView(tx, deps, id);
  });
  if (failure) throw failure;
  if (o.afterCommit && before) await o.afterCommit(before);
  return view!;
}

/** DRAFT -> SUBMITTED including the staff working copy. Shared by /submit and /from-cart. */
function submitOptions(body: z.infer<typeof submitBody>): RunOptions {
  return {
    event: "SUBMIT",
    pre: async (tx, quote) => {
      if ((await customerLines(tx, quote.id)).length === 0) {
        return new ApiError("VALIDATION_FAILED", "Add at least one item before submitting", { field: "lines" });
      }
    },
    data: () => ({
      ...(body.notesToSales !== undefined ? { notesToSales: body.notesToSales } : {}),
      ...(body.neededBy !== undefined ? { neededBy: new Date(body.neededBy) } : {}),
      ...(body.poNumber !== undefined ? { poNumber: body.poNumber } : {}),
    }),
    post: async (tx, quote) => materializeStaffSet(tx, quote.id),
  };
}

function requireDraft(status: string) {
  if (status !== "DRAFT") throw new ApiError("NOT_EDITABLE", "Lines can only be changed while the quote is a draft", { status });
}

export async function customerRoutes(app: FastifyInstance) {
  const deps = app.deps;
  app.addHook("onRequest", customerAuth(deps)); // before body parsing: anonymous callers get 401, never 400

  // ---------------------------------------------------------------- list / create
  app.get("/quotes", async (req) => {
    const buyer = buyerOf(req);
    const q = parse(listQuery, req.query);
    const where: Prisma.QuoteWhereInput = { ...scopeWhere(deps, buyer) };
    if (q.status) where.status = q.status;
    if (q.jobId) where.jobId = q.jobId;
    if (q.q) {
      const term = q.q.trim();
      const num = /^q?-?(\d{3,})$/i.exec(term);
      where.OR = [
        { title: { contains: term, mode: "insensitive" } },
        { poNumber: { contains: term, mode: "insensitive" } },
        { job: { is: { name: { contains: term, mode: "insensitive" } } } },
        { job: { is: { poNumber: { contains: term, mode: "insensitive" } } } },
        ...(num ? [{ number: Number(num[1]) }] : []),
      ];
    }
    const rows = await deps.prisma.quote.findMany({
      where,
      include: { job: true },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const { items, nextCursor } = page(rows, q.limit);
    const now = deps.now();
    return { items: items.map((r) => customerSummary(r, now)), nextCursor };
  });

  app.post("/quotes", async (req, reply) => {
    const buyer = buyerOf(req);
    const body = parse(createQuoteBody, req.body);
    const view = await deps.prisma.$transaction(async (tx) => {
      const job = await resolveJob(tx, deps, buyer, body);
      const quote = await createDraft(tx, deps, buyer, {
        title: body.title,
        job,
        poNumber: body.poNumber ?? job?.poNumber ?? null,
        neededBy: body.neededBy,
        actor: "customer",
        actorId: buyer.customerId,
      });
      if (body.setActive) await setActiveQuote(tx, deps, buyer, quote.id);
      return loadCustomerView(tx, deps, quote.id);
    });
    return reply.status(201).send(view);
  });

  app.post("/quotes/from-cart", async (req, reply) => {
    const buyer = buyerOf(req);
    const body = parse(fromCartBody, req.body);
    const pricing = await fetchPricing(deps, buyer, body.cartLines.map((l) => l.variantId));
    // Phase 1: create / fill the draft (one transaction). Phase 2: submit through the shared transition runner.
    const quoteId = await deps.prisma.$transaction(async (tx) => {
      let id: string;
      if (body.target.mode === "new") {
        const t = body.target;
        const job = await resolveJob(tx, deps, buyer, t);
        const quote = await createDraft(tx, deps, buyer, {
          title: t.title,
          job,
          poNumber: t.poNumber ?? job?.poNumber ?? null,
          neededBy: t.neededBy,
          notesToSales: t.notesToSales,
          actor: "customer",
          actorId: buyer.customerId,
        });
        id = quote.id;
        await setActiveQuote(tx, deps, buyer, id);
      } else {
        const quote = await getScopedQuote(tx, deps, buyer, body.target.quoteId, true);
        requireDraft(quote.status);
        id = quote.id;
      }
      for (const l of body.cartLines) await addLine(tx, id, pricing.get(l.variantId)!, l.qty, { addedBy: "CUSTOMER" });
      await writeEvent(tx, id, "FROM_CART", "customer", buyer.customerId, { lineCount: body.cartLines.length }, deps.now());
      await refreshDerived(tx, id);
      return id;
    });
    const view = body.submit ? await runCustomerTransition(deps, buyer, quoteId, submitOptions({})) : await deps.prisma.$transaction((tx) => loadCustomerView(tx, deps, quoteId));
    return reply.status(201).send(view);
  });

  // ---------------------------------------------------------------- one quote
  app.get("/quotes/:id", async (req) => {
    const { id } = req.params as { id: string };
    return deps.prisma.$transaction(async (tx) => {
      await getScopedQuote(tx, deps, buyerOf(req), id);
      return loadCustomerView(tx, deps, id);
    });
  });

  app.patch("/quotes/:id", async (req) => {
    const buyer = buyerOf(req);
    const { id } = req.params as { id: string };
    const body = parse(updateQuoteBody, req.body);
    return deps.prisma.$transaction(async (tx) => {
      const quote = await getScopedQuote(tx, deps, buyer, id, true);
      const onlyWatchers = Object.keys(body).every((k) => k === "watchers");
      const open = !["ORDERED", "EXPIRED", "DECLINED", "ARCHIVED"].includes(quote.status);
      if (quote.status !== "DRAFT" && !(onlyWatchers && open)) {
        throw new ApiError("NOT_EDITABLE", "Only drafts can be edited", { status: quote.status });
      }
      const data: Prisma.QuoteUncheckedUpdateInput = {};
      if (body.title !== undefined) data.title = body.title;
      if (body.poNumber !== undefined) data.poNumber = body.poNumber;
      if (body.neededBy !== undefined) data.neededBy = body.neededBy ? new Date(body.neededBy) : null;
      if (body.shipTo !== undefined) data.shipToAddress = body.shipTo === null ? Prisma.DbNull : (body.shipTo as Prisma.InputJsonValue);
      if (body.notesToSales !== undefined) data.notesToSales = body.notesToSales;
      if (body.watchers !== undefined) data.watchers = body.watchers;
      if (body.newJob || body.jobId !== undefined) {
        const job = body.newJob || body.jobId ? await resolveJob(tx, deps, buyer, body) : null;
        data.jobId = job?.id ?? null;
      }
      await tx.quote.update({ where: { id }, data });
      await writeEvent(tx, id, "UPDATE_HEADER", "customer", buyer.customerId, { fields: Object.keys(body) }, deps.now());
      return loadCustomerView(tx, deps, id);
    });
  });

  app.delete("/quotes/:id", async (req, reply) => {
    const buyer = buyerOf(req);
    const { id } = req.params as { id: string };
    await runCustomerTransition(deps, buyer, id, { event: "DELETE", data: () => ({ deletedAt: deps.now() }) });
    await deps.prisma.activeQuote.deleteMany({ where: { shop: deps.config.shopDomain, customerId: buyer.customerId, quoteId: id } });
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- lines (DRAFT only)
  app.post("/quotes/:id/lines", async (req, reply) => {
    const buyer = buyerOf(req);
    const { id } = req.params as { id: string };
    const body = parse(addLineBody, req.body);
    const pricing = await fetchPricing(deps, buyer, [body.variantId]);
    const view = await deps.prisma.$transaction(async (tx) => {
      const quote = await getScopedQuote(tx, deps, buyer, id, true);
      requireDraft(quote.status);
      await addLine(tx, id, pricing.get(body.variantId)!, body.qty, { lineNote: body.lineNote, addedBy: "CUSTOMER" });
      await refreshDerived(tx, id);
      return loadCustomerView(tx, deps, id);
    });
    return reply.status(201).send(view);
  });

  app.patch("/quotes/:id/lines/:lineId", async (req) => {
    const buyer = buyerOf(req);
    const { id, lineId } = req.params as { id: string; lineId: string };
    const body = parse(updateLineBody, req.body);
    return deps.prisma.$transaction(async (tx) => {
      const quote = await getScopedQuote(tx, deps, buyer, id, true);
      requireDraft(quote.status);
      const line = await tx.quoteLine.findFirst({ where: { id: lineId, quoteId: id, set: "CUSTOMER" } });
      if (!line) throw notFound("Line");
      await tx.quoteLine.update({
        where: { id: lineId },
        data: { ...(body.qty !== undefined ? { qty: body.qty } : {}), ...(body.lineNote !== undefined ? { lineNote: body.lineNote } : {}) },
      });
      await refreshDerived(tx, id);
      return loadCustomerView(tx, deps, id);
    });
  });

  app.delete("/quotes/:id/lines/:lineId", async (req) => {
    const buyer = buyerOf(req);
    const { id, lineId } = req.params as { id: string; lineId: string };
    return deps.prisma.$transaction(async (tx) => {
      const quote = await getScopedQuote(tx, deps, buyer, id, true);
      requireDraft(quote.status);
      const line = await tx.quoteLine.findFirst({ where: { id: lineId, quoteId: id, set: "CUSTOMER" } });
      if (!line) throw notFound("Line");
      await tx.quoteLine.delete({ where: { id: lineId } });
      await refreshDerived(tx, id);
      return loadCustomerView(tx, deps, id);
    });
  });

  // ---------------------------------------------------------------- transitions
  app.post("/quotes/:id/submit", async (req) => {
    const { id } = req.params as { id: string };
    return runCustomerTransition(deps, buyerOf(req), id, submitOptions(parse(submitBody, req.body)));
  });

  app.post("/quotes/:id/withdraw", async (req) => {
    const { id } = req.params as { id: string };
    return runCustomerTransition(deps, buyerOf(req), id, {
      event: "WITHDRAW",
      // Back to a customer-editable draft: any rep working copy is discarded.
      post: async (tx, quote) => {
        await tx.quoteLine.deleteMany({ where: { quoteId: quote.id, set: "STAFF" } });
      },
    });
  });

  app.post("/quotes/:id/accept", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(acceptBody, req.body);
    const now = deps.now();
    return runCustomerTransition(deps, buyerOf(req), id, {
      event: "ACCEPT",
      payload: { versionNo: body.versionNo },
      pre: async (tx, quote) => {
        if (quote.status === "QUOTE_READY") {
          if (quote.expiresAt && quote.expiresAt.getTime() <= now.getTime()) {
            // Persist the expiry the cron hasn't applied yet, then refuse.
            await applyTransition(tx, { quote, event: "EXPIRE", actor: "system", actorId: null, now, payload: { lazy: true } });
            return new ApiError("INVALID_TRANSITION", "This quote has expired. Ask your rep for a new quote.", { status: "EXPIRED" });
          }
          if (body.versionNo !== undefined && body.versionNo !== quote.currentVersion) {
            return new ApiError("VERSION_MISMATCH", "A newer version of this quote was sent. Review it before accepting.", {
              currentVersion: quote.currentVersion,
            });
          }
        }
      },
    });
  });

  app.post("/quotes/:id/request-changes", async (req) => {
    const { id } = req.params as { id: string };
    const buyer = buyerOf(req);
    const body = parse(requestChangesBody, req.body);
    return runCustomerTransition(deps, buyer, id, {
      event: "REQUEST_CHANGES",
      payload: { message: body.message },
      // Shown in the conversation too, but NO separate NEW_MESSAGE event: REQUEST_CHANGES already notifies sales.
      post: async (tx, quote) => {
        await tx.message.create({
          data: { quoteId: quote.id, authorType: "CUSTOMER", authorId: buyer.customerId, authorName: buyer.name, body: body.message },
        });
      },
    });
  });

  app.post("/quotes/:id/decline", async (req) => {
    const { id } = req.params as { id: string };
    const buyer = buyerOf(req);
    const body = parse(declineBody, req.body);
    return runCustomerTransition(deps, buyer, id, {
      event: "DECLINE",
      payload: { reason: body.reason ?? null },
      post: async (tx, quote) => {
        if (body.reason) {
          await tx.message.create({
            data: { quoteId: quote.id, authorType: "CUSTOMER", authorId: buyer.customerId, authorName: buyer.name, body: body.reason },
          });
        }
      },
    });
  });

  app.post("/quotes/:id/reopen", async (req) => {
    const { id } = req.params as { id: string };
    return runCustomerTransition(deps, buyerOf(req), id, {
      event: "REOPEN",
      payload: {},
      data: () => ({ draftOrderId: null, draftOrderInvoiceUrl: null, draftOrderVersion: null }),
      afterCommit: async (before) => {
        if (before.draftOrderId) await deps.shopify.deleteDraftOrder(before.draftOrderId);
      },
    });
  });

  app.post("/quotes/:id/duplicate", async (req, reply) => {
    const buyer = buyerOf(req);
    const { id } = req.params as { id: string };
    // Read source + price outside the write transaction (Shopify calls are slow).
    const src = await deps.prisma.$transaction(async (tx) => {
      const quote = await getScopedQuote(tx, deps, buyer, id);
      return { quote, lines: await customerVisibleLines(tx, quote) };
    });
    const prices = new Map<string, Awaited<ReturnType<typeof deps.shopify.getVariantPricing>>>();
    for (const l of src.lines) {
      if (!prices.has(l.variantId)) prices.set(l.variantId, await deps.shopify.getVariantPricing(buyer, l.variantId));
    }
    const view = await deps.prisma.$transaction(async (tx) => {
      const job = src.quote.jobId ? await tx.job.findUnique({ where: { id: src.quote.jobId } }) : null;
      const copy = await createDraft(tx, deps, buyer, {
        title: `${src.quote.title} (copy)`.slice(0, 200),
        job,
        poNumber: src.quote.poNumber,
        actor: "customer",
        actorId: buyer.customerId,
      });
      for (const l of src.lines) {
        const p = prices.get(l.variantId);
        if (p) await addLine(tx, copy.id, p, l.qty, { lineNote: l.lineNote, addedBy: "CUSTOMER" }); // discontinued variants are skipped
      }
      await writeEvent(tx, copy.id, "DUPLICATED_FROM", "customer", buyer.customerId, { sourceQuoteId: id }, deps.now());
      await setActiveQuote(tx, deps, buyer, copy.id);
      await refreshDerived(tx, copy.id);
      return loadCustomerView(tx, deps, copy.id);
    });
    return reply.status(201).send(view);
  });

  app.post("/quotes/:id/checkout", async (req) => {
    const { id } = req.params as { id: string };
    return checkoutQuote(deps, buyerOf(req), id);
  });

  // ---------------------------------------------------------------- conversation
  app.get("/quotes/:id/messages", async (req) => {
    const { id } = req.params as { id: string };
    const q = parse(pageQuery, req.query);
    await getScopedQuote(deps.prisma, deps, buyerOf(req), id);
    const rows = await deps.prisma.message.findMany({
      where: { quoteId: id, internal: false },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const { items, nextCursor } = page(rows, q.limit);
    return { items: items.map(customerMessage), nextCursor };
  });

  app.post("/quotes/:id/messages", async (req, reply) => {
    const buyer = buyerOf(req);
    const { id } = req.params as { id: string };
    const body = parse(postMessageBody, req.body);
    const attachments = asAttachments(body.attachments ?? []);
    if (attachments.some((a) => !deps.attachments.isOwnUrl(a.url) || !a.url.includes(`/quotes/${id}/`))) {
      throw new ApiError("VALIDATION_FAILED", "Attachments must be uploaded through the upload URL endpoint", { field: "attachments" });
    }
    const msg = await deps.prisma.$transaction(async (tx) => {
      const quote = await getScopedQuote(tx, deps, buyer, id, true);
      if (quote.status === "DRAFT") throw new ApiError("NOT_EDITABLE", "Submit the quote to start a conversation", { status: quote.status });
      const m = await tx.message.create({
        data: {
          quoteId: id,
          authorType: "CUSTOMER",
          authorId: buyer.customerId,
          authorName: buyer.name,
          body: body.body,
          attachments: attachments as unknown as Prisma.InputJsonValue,
          internal: false,
        },
      });
      await writeEvent(tx, id, "NEW_MESSAGE", "customer", buyer.customerId, { messageId: m.id }, deps.now());
      await tx.quote.update({ where: { id }, data: { updatedAt: deps.now() } });
      return m;
    });
    return reply.status(201).send(customerMessage(msg));
  });

  app.post("/quotes/:id/attachments/upload-url", async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(uploadUrlBody, req.body);
    await getScopedQuote(deps.prisma, deps, buyerOf(req), id);
    const up = deps.attachments.createUpload({ quoteId: id, name: body.name, mime: body.mime, size: body.size, now: deps.now() });
    return { uploadUrl: up.uploadUrl, fileUrl: up.fileUrl, expiresAt: up.expiresAt.toISOString() };
  });

  // ---------------------------------------------------------------- active quote
  const activeView = async (buyer: BuyerContext) => {
    const shop = deps.config.shopDomain;
    const row = await deps.prisma.activeQuote.findUnique({ where: { shop_customerId: { shop, customerId: buyer.customerId } } });
    const quote = row
      ? await deps.prisma.quote.findFirst({ where: { id: row.quoteId, status: "DRAFT", ...scopeWhere(deps, buyer) } })
      : null;
    return quote
      ? { quoteId: quote.id, number: quote.number, title: quote.title, lineCount: quote.lineCount }
      : { quoteId: null, number: null, title: null, lineCount: null };
  };

  app.get("/active-quote", async (req) => activeView(buyerOf(req)));

  app.put("/active-quote", async (req) => {
    const buyer = buyerOf(req);
    const body = parse(activeBody, req.body);
    const shop = deps.config.shopDomain;
    if (body.quoteId === null) {
      await deps.prisma.activeQuote.deleteMany({ where: { shop, customerId: buyer.customerId } });
    } else {
      await deps.prisma.$transaction(async (tx) => {
        const quote = await getScopedQuote(tx, deps, buyer, body.quoteId!);
        requireDraft(quote.status);
        await setActiveQuote(tx, deps, buyer, quote.id);
      });
    }
    return activeView(buyer);
  });

  await registerPrefsRoutes(app, deps);
}

export { MESSAGE_PAGE };
