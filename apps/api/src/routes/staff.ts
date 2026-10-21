import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canTransition } from "shared";
import { staffAuth } from "../auth/middleware";
import type { AppDeps, StaffPrincipal } from "../context";
import { createDraft, addLine, fetchPricing, resolveJob } from "../domain/customerQuotes";
import { floorFor, isBelowFloor, materializeStaffSet, refreshDerived } from "../domain/lines";
import { fmt } from "../domain/money";
import {
  WORKING_STATUSES,
  getStaffQuoteRow,
  loadStaffView,
  saveDraftRevision,
  sendRevision,
} from "../domain/staffQuotes";
import { applyTransition, lockQuote, writeEvent } from "../domain/transitions";
import { ApiError, notFound } from "../errors";
import { page, parse } from "../http";
import { asAttachments } from "../serializers/customer";
import { staffMessage, staffSummary } from "../serializers/staff";

const money = z.string().regex(/^\d+(\.\d{1,2})?$/, "Amount like 12.50");
const newJob = z.object({ name: z.string().min(1).max(200), poNumber: z.string().max(100).optional(), siteAddress: z.string().max(500).optional() });

const listQuery = z.object({
  tab: z.enum(["needs_response", "unassigned", "waiting_customer", "accepted", "expiring", "all"]).default("all"),
  rep: z.string().optional(),
  team: z.string().optional(),
  q: z.string().max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
const pageQuery = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(25) });
const createBody = z.object({
  customerId: z.string().min(1),
  companyLocationId: z.string().optional(),
  title: z.string().min(1).max(200),
  jobId: z.string().optional(),
  newJob: newJob.optional(),
  lines: z.array(z.object({ variantId: z.string().min(1), qty: z.number().int().min(1).max(100000), lineNote: z.string().max(1000).optional() })).optional(),
  submit: z.boolean().default(false),
});
const assignBody = z
  .object({ repId: z.string().nullable(), teamId: z.string().nullable() })
  .partial()
  .refine((o) => Object.keys(o).length > 0, "repId or teamId is required");
const draftBody = z.object({
  lines: z
    .array(
      z.object({
        id: z.string().optional(),
        variantId: z.string().min(1),
        qty: z.number().int().min(1).max(100000),
        quotedPrice: money,
        lineNote: z.string().max(1000).nullable().optional(),
      }),
    )
    .max(500),
  freight: money.optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  repNote: z.string().max(10000).nullable().optional(),
  internalNote: z.string().max(10000).nullable().optional(),
});
const approveBody = z.object({ lineIds: z.array(z.string()).optional(), note: z.string().max(2000).optional() });
const declineBody = z.object({ reason: z.string().max(2000).optional() });
const messageBody = z.object({
  body: z.string().min(1).max(10000),
  attachments: z.array(z.object({ url: z.string().url(), name: z.string(), size: z.number().int(), mime: z.string() })).max(10).optional(),
  internal: z.boolean().default(false),
});

const SALES_STATUSES = ["SUBMITTED", "IN_REVIEW", "CHANGES_REQUESTED"] as const;
const OPEN_STATUSES = ["SUBMITTED", "IN_REVIEW", "QUOTE_READY", "CHANGES_REQUESTED", "ACCEPTED"] as const;
const EXPIRING_DAYS = 3;
const DAY = 24 * 60 * 60 * 1000;

const staffOf = (req: { staffPrincipal?: StaffPrincipal }) => req.staffPrincipal!.staff;

export async function staffRoutes(app: FastifyInstance) {
  const deps: AppDeps = app.deps;
  const shop = deps.config.shopDomain;
  app.addHook("preHandler", staffAuth(deps));

  const view = (id: string, actor: StaffPrincipal["staff"]) => deps.prisma.$transaction((tx) => loadStaffView(tx, deps, id, actor));

  // ---------------------------------------------------------------- inbox
  app.get("/quotes", async (req) => {
    const me = staffOf(req);
    const q = parse(listQuery, req.query);
    const now = deps.now();
    const where: Prisma.QuoteWhereInput = { shop, deletedAt: null };
    switch (q.tab) {
      case "needs_response":
        where.status = { in: [...SALES_STATUSES] };
        break;
      case "unassigned":
        where.status = { in: [...SALES_STATUSES] };
        where.assignedRepId = null;
        break;
      case "waiting_customer":
        where.status = "QUOTE_READY";
        break;
      case "accepted":
        where.status = "ACCEPTED";
        break;
      case "expiring":
        where.status = { in: ["QUOTE_READY", "ACCEPTED"] };
        where.expiresAt = { gt: now, lte: new Date(now.getTime() + EXPIRING_DAYS * DAY) };
        break;
      case "all":
        // Customers' private drafts stay out of the inbox; drafts a rep created on their behalf are shown.
        where.OR = [{ status: { notIn: ["DRAFT", "ARCHIVED"] } }, { status: "DRAFT", createdByStaffId: { not: null } }];
        break;
    }
    if (q.rep) where.assignedRepId = q.rep === "me" ? me.id : q.rep;
    if (q.team) where.teamId = q.team;
    if (q.q) {
      const term = q.q.trim();
      const num = /^q?-?(\d{3,})$/i.exec(term);
      const search: Prisma.QuoteWhereInput[] = [
        { title: { contains: term, mode: "insensitive" } },
        { customerName: { contains: term, mode: "insensitive" } },
        { companyName: { contains: term, mode: "insensitive" } },
        { poNumber: { contains: term, mode: "insensitive" } },
        { job: { is: { name: { contains: term, mode: "insensitive" } } } },
        ...(num ? [{ number: Number(num[1]) }] : []),
      ];
      where.AND = [{ OR: search }];
    }
    const rows = await deps.prisma.quote.findMany({
      where,
      include: { job: true, assignedRep: true },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const { items, nextCursor } = page(rows, q.limit);
    return { items: items.map(staffSummary), nextCursor };
  });

  app.get("/reports/summary", async () => {
    const now = deps.now();
    const base: Prisma.QuoteWhereInput = { shop, deletedAt: null };
    const weekAgo = new Date(now.getTime() - 7 * DAY);
    const [needsResponse, unassigned, open, expiringSoon, acceptedEvents] = await Promise.all([
      deps.prisma.quote.count({ where: { ...base, status: { in: [...SALES_STATUSES] } } }),
      deps.prisma.quote.count({ where: { ...base, status: { in: [...SALES_STATUSES] }, assignedRepId: null } }),
      deps.prisma.quote.aggregate({ where: { ...base, status: { in: [...OPEN_STATUSES] } }, _sum: { total: true } }),
      deps.prisma.quote.count({
        where: { ...base, status: { in: ["QUOTE_READY", "ACCEPTED"] }, expiresAt: { gt: now, lte: new Date(now.getTime() + EXPIRING_DAYS * DAY) } },
      }),
      deps.prisma.event.findMany({ where: { type: "ACCEPT", createdAt: { gte: weekAgo }, quote: { shop } }, select: { quoteId: true } }),
    ]);
    const acceptedIds = [...new Set(acceptedEvents.map((e) => e.quoteId))];
    const accepted = acceptedIds.length
      ? await deps.prisma.quote.aggregate({ where: { id: { in: acceptedIds } }, _sum: { total: true } })
      : { _sum: { total: null } };
    return {
      needsResponse,
      unassigned,
      openValue: fmt(open._sum.total),
      acceptedThisWeek: acceptedIds.length,
      acceptedThisWeekValue: fmt(accepted._sum.total),
      expiringSoon,
    };
  });

  // ---------------------------------------------------------------- create / read
  app.post("/quotes", async (req, reply) => {
    const me = staffOf(req);
    const body = parse(createBody, req.body);
    const buyer = await deps.shopify.resolveBuyer(body.customerId, body.companyLocationId ?? null);
    if (!buyer) throw new ApiError("VALIDATION_FAILED", "Customer is not a company contact", { field: "customerId" });
    if (body.companyLocationId && buyer.companyLocationId !== body.companyLocationId) {
      throw new ApiError("VALIDATION_FAILED", "Customer does not belong to that company location", { field: "companyLocationId" });
    }
    const pricing = await fetchPricing(deps, buyer, (body.lines ?? []).map((l) => l.variantId));
    const id = await deps.prisma.$transaction(async (tx) => {
      const job = await resolveJob(tx, deps, buyer, body);
      const quote = await createDraft(tx, deps, buyer, {
        title: body.title,
        job,
        poNumber: job?.poNumber ?? null,
        createdByStaffId: me.id,
        actor: "staff",
        actorId: me.id,
      });
      for (const l of body.lines ?? []) await addLine(tx, quote.id, pricing.get(l.variantId)!, l.qty, { lineNote: l.lineNote, addedBy: "STAFF" });
      await refreshDerived(tx, quote.id);
      if (body.submit) {
        const locked = (await lockQuote(tx, quote.id))!;
        if ((body.lines ?? []).length === 0) throw new ApiError("VALIDATION_FAILED", "Add at least one line before submitting", { field: "lines" });
        await applyTransition(tx, {
          quote: locked,
          event: "SUBMIT",
          actor: "staff",
          actorId: me.id,
          now: deps.now(),
          data: { assignedRep: { connect: { id: me.id } } },
        });
        await materializeStaffSet(tx, quote.id);
        await refreshDerived(tx, quote.id);
      }
      return quote.id;
    });
    return reply.status(201).send(await view(id, me));
  });

  app.get("/quotes/:id", async (req) => {
    const { id } = req.params as { id: string };
    return deps.prisma.$transaction(async (tx) => {
      await getStaffQuoteRow(tx, deps, id);
      return loadStaffView(tx, deps, id, staffOf(req));
    });
  });

  // ---------------------------------------------------------------- ownership
  app.post("/quotes/:id/claim", async (req) => {
    const me = staffOf(req);
    const { id } = req.params as { id: string };
    await deps.prisma.$transaction(async (tx) => {
      const quote = await getStaffQuoteRow(tx, deps, id, true);
      if (canTransition(quote.status, "CLAIM", "staff")) {
        await applyTransition(tx, { quote, event: "CLAIM", actor: "staff", actorId: me.id, now: deps.now(), data: { assignedRep: { connect: { id: me.id } } } });
      } else if (["IN_REVIEW", "QUOTE_READY", "ACCEPTED"].includes(quote.status)) {
        await tx.quote.update({ where: { id }, data: { assignedRepId: me.id } });
        await writeEvent(tx, id, "ASSIGN", "staff", me.id, { repId: me.id }, deps.now());
      } else {
        throw new ApiError("INVALID_TRANSITION", `CLAIM is not allowed from ${quote.status}`, { status: quote.status });
      }
      await refreshDerived(tx, id);
    });
    return view(id, me);
  });

  app.post("/quotes/:id/assign", async (req) => {
    const me = staffOf(req);
    const { id } = req.params as { id: string };
    const body = parse(assignBody, req.body);
    await deps.prisma.$transaction(async (tx) => {
      await getStaffQuoteRow(tx, deps, id, true);
      if (body.repId) {
        const rep = await tx.staff.findFirst({ where: { id: body.repId, shop } });
        if (!rep) throw new ApiError("VALIDATION_FAILED", "Rep not found", { field: "repId" });
      }
      await tx.quote.update({
        where: { id },
        data: {
          ...(body.repId !== undefined ? { assignedRepId: body.repId } : {}),
          ...(body.teamId !== undefined ? { teamId: body.teamId } : {}),
        },
      });
      await writeEvent(tx, id, "ASSIGN", "staff", me.id, { repId: body.repId ?? null, teamId: body.teamId ?? null }, deps.now());
      await refreshDerived(tx, id);
    });
    return view(id, me);
  });

  // ---------------------------------------------------------------- revisions
  app.put("/quotes/:id/draft-revision", async (req) => {
    const me = staffOf(req);
    const { id } = req.params as { id: string };
    const body = parse(draftBody, req.body);
    const probe = await deps.prisma.quote.findFirst({ where: { id, shop } });
    if (!probe) throw notFound();
    // Prefetch contextual pricing for NEW lines outside the transaction.
    const newVariants = body.lines.filter((l) => !l.id).map((l) => l.variantId);
    const prices = new Map<string, Awaited<ReturnType<typeof deps.shopify.getVariantPricing>>>();
    for (const v of new Set(newVariants)) {
      prices.set(v, await deps.shopify.getVariantPricing({ companyLocationId: probe.companyLocationId ?? "", customerId: probe.customerId }, v));
    }
    await deps.prisma.$transaction(async (tx) => {
      const quote = await getStaffQuoteRow(tx, deps, id, true);
      if (!(WORKING_STATUSES as readonly string[]).includes(quote.status)) {
        throw new ApiError("NOT_EDITABLE", "This quote can't be edited in its current status", { status: quote.status });
      }
      await saveDraftRevision(tx, deps, id, body, async (v) => prices.get(v) ?? null);
    });
    return view(id, me);
  });

  app.post("/quotes/:id/send", async (req) => {
    const me = staffOf(req);
    const { id } = req.params as { id: string };
    await deps.prisma.$transaction(async (tx) => {
      await getStaffQuoteRow(tx, deps, id, true);
      await sendRevision(tx, deps, id, me);
    });
    return view(id, me);
  });

  app.post("/quotes/:id/approve-floor", async (req) => {
    const me = staffOf(req);
    const { id } = req.params as { id: string };
    const body = parse(approveBody, req.body);
    if (!me.isManager) throw new ApiError("FORBIDDEN", "Only a manager can approve prices below the floor");
    await deps.prisma.$transaction(async (tx) => {
      const quote = await getStaffQuoteRow(tx, deps, id, true);
      const lines = await tx.quoteLine.findMany({ where: { quoteId: id, set: "STAFF" } });
      const floor = floorFor(quote.assignedRep, me);
      if (body.lineIds) {
        const known = new Set(lines.map((l) => l.id));
        const bad = body.lineIds.filter((l) => !known.has(l));
        if (bad.length) throw new ApiError("VALIDATION_FAILED", "Unknown line ids", { lineIds: bad });
      }
      const targets = lines.filter((l) => isBelowFloor(l, floor) && !l.floorApproved && (!body.lineIds || body.lineIds.includes(l.id)));
      if (targets.length) {
        await tx.quoteLine.updateMany({ where: { id: { in: targets.map((l) => l.id) } }, data: { floorApproved: true, floorApprovedById: me.id } });
      }
      await writeEvent(tx, id, "FLOOR_APPROVED", "staff", me.id, { lineIds: targets.map((l) => l.id), note: body.note ?? null }, deps.now());
      await refreshDerived(tx, id);
    });
    return view(id, me);
  });

  app.post("/quotes/:id/reopen", async (req) => {
    const me = staffOf(req);
    const { id } = req.params as { id: string };
    let previousDraftOrder: string | null = null;
    await deps.prisma.$transaction(async (tx) => {
      const quote = await getStaffQuoteRow(tx, deps, id, true);
      previousDraftOrder = quote.draftOrderId;
      await applyTransition(tx, {
        quote,
        event: "REOPEN",
        actor: "staff",
        actorId: me.id,
        now: deps.now(),
        payload: { previousDraftOrderId: quote.draftOrderId },
        data: { draftOrderId: null, draftOrderInvoiceUrl: null, draftOrderVersion: null },
      });
      await refreshDerived(tx, id);
    });
    if (previousDraftOrder) await deps.shopify.deleteDraftOrder(previousDraftOrder);
    return view(id, me);
  });

  app.post("/quotes/:id/decline", async (req) => {
    const me = staffOf(req);
    const { id } = req.params as { id: string };
    const body = parse(declineBody, req.body);
    await deps.prisma.$transaction(async (tx) => {
      const quote = await getStaffQuoteRow(tx, deps, id, true);
      await applyTransition(tx, { quote, event: "DECLINE", actor: "staff", actorId: me.id, now: deps.now(), payload: { reason: body.reason ?? null } });
      if (body.reason) {
        await tx.message.create({ data: { quoteId: id, authorType: "STAFF", authorId: me.id, authorName: me.name, body: body.reason } });
      }
      await refreshDerived(tx, id);
    });
    return view(id, me);
  });

  // ---------------------------------------------------------------- conversation
  app.get("/quotes/:id/messages", async (req) => {
    const { id } = req.params as { id: string };
    const q = parse(pageQuery, req.query);
    await getStaffQuoteRow(deps.prisma, deps, id);
    const rows = await deps.prisma.message.findMany({
      where: { quoteId: id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const { items, nextCursor } = page(rows, q.limit);
    return { items: items.map(staffMessage), nextCursor };
  });

  app.post("/quotes/:id/messages", async (req, reply) => {
    const me = staffOf(req);
    const { id } = req.params as { id: string };
    const body = parse(messageBody, req.body);
    const attachments = asAttachments(body.attachments ?? []);
    if (attachments.some((a) => !deps.attachments.isOwnUrl(a.url))) {
      throw new ApiError("VALIDATION_FAILED", "Attachments must be uploaded through the upload URL endpoint", { field: "attachments" });
    }
    const msg = await deps.prisma.$transaction(async (tx) => {
      await getStaffQuoteRow(tx, deps, id, true);
      const m = await tx.message.create({
        data: {
          quoteId: id,
          authorType: "STAFF",
          authorId: me.id,
          authorName: me.name,
          body: body.body,
          internal: body.internal,
          attachments: attachments as unknown as Prisma.InputJsonValue,
        },
      });
      // Internal notes NEVER emit an event, so the worker can't notify the customer about them (rule 5).
      if (!body.internal) await writeEvent(tx, id, "NEW_MESSAGE", "staff", me.id, { messageId: m.id }, deps.now());
      await tx.quote.update({ where: { id }, data: { updatedAt: deps.now() } });
      return m;
    });
    return reply.status(201).send(staffMessage(msg));
  });
}
