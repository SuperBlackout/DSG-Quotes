import { Prisma, type Event, type Message, type Quote } from "@prisma/client";
import type { WorkerDeps } from "./config";
import { isSmsOptedOut, optOutPhone } from "./inbound";
import { replyAddress } from "./lib/reply-token";
import { inQuietHours, quietEndsAt } from "./lib/quiet-hours";
import { ProviderError } from "./providers/types";
import { TWILIO_UNSUBSCRIBED } from "./providers/twilio";
import { resolveRecipients, type Recipient } from "./recipients";
import { planFor, type NotifyPlan, type Side } from "./rules";
import { renderEmail, renderSms, type TemplateCtx } from "./templates";

type Tx = Prisma.TransactionClient;
type Json = Record<string, unknown>;

/**
 * An SMS held back by quiet hours: a queue entry in `events`, unprocessed (`notifiedAt IS NULL`) until `payload.sendAfter`, then sent
 * and deleted (the outcome is a `NotificationLog` row, so the staff timeline does not fill up with worker bookkeeping).
 */
export const DEFERRED_TYPE = "SMS_DEFERRED";

export type EventOutcome = "sent" | "ignored" | "held" | "retry" | "busy" | "taken" | "deferred_sent" | "deferred_waiting" | "deferred_cancelled";

export interface BatchSummary {
  processed: number;
  outcomes: Record<string, number>;
}

const iso = (d: Date) => d.toISOString();
const asObj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const json = (v: Json) => v as Prisma.InputJsonValue;

/**
 * Consume unprocessed events. Safe to run in several worker processes at once:
 *  1. candidates are read without locks;
 *  2. each one is processed in its own transaction that first takes a per-quote advisory lock (try-lock: a busy quote is skipped
 *     this round, which also keeps NEW_MESSAGE bundling single-threaded), then `SELECT ... FOR UPDATE SKIP LOCKED` on the event row,
 *     and re-checks `notifiedAt IS NULL` under the lock;
 *  3. the event is marked notified in the same transaction that wrote the send log, so a second worker either skips the row
 *     (locked) or sees it already done.
 */
export async function processBatch(deps: WorkerDeps, opts: { limit?: number } = {}): Promise<BatchSummary> {
  const now = iso(deps.now());
  const candidates = await deps.prisma.$queryRaw<{ id: string; quoteId: string }[]>`
    SELECT "id", "quoteId" FROM "Event"
    WHERE "notifiedAt" IS NULL
      AND NOT ("type" = ${DEFERRED_TYPE} AND COALESCE("payload"->>'sendAfter', '') > ${now})
      AND COALESCE("payload"->'_notify'->>'nextAttemptAt', '') <= ${now}
    ORDER BY "createdAt", "id"
    LIMIT ${opts.limit ?? 50}`;
  const summary: BatchSummary = { processed: 0, outcomes: {} };
  for (const c of candidates) {
    let outcome: EventOutcome;
    try {
      outcome = await deps.prisma.$transaction((tx) => processEvent(tx, deps, c.id, c.quoteId), { timeout: 120_000, maxWait: 20_000 });
    } catch (e) {
      deps.log.error("event processing failed; will retry on the next poll", { eventId: c.id, error: (e as Error).message });
      summary.outcomes.error = (summary.outcomes.error ?? 0) + 1;
      continue;
    }
    summary.processed++;
    summary.outcomes[outcome] = (summary.outcomes[outcome] ?? 0) + 1;
  }
  return summary;
}

async function processEvent(tx: Tx, deps: WorkerDeps, eventId: string, quoteId: string): Promise<EventOutcome> {
  const locked = (await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${quoteId})) AS locked`)[0]?.locked;
  if (!locked) return "busy";
  const row = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Event" WHERE "id" = ${eventId} AND "notifiedAt" IS NULL FOR UPDATE SKIP LOCKED`;
  if (row.length === 0) return "taken";
  const ev = await tx.event.findUniqueOrThrow({ where: { id: eventId } });

  if (ev.type === DEFERRED_TYPE) return sendDeferred(tx, deps, ev);

  const plan = planFor(ev.type, ev.actorType);
  const quote = plan ? await tx.quote.findUnique({ where: { id: ev.quoteId } }) : null;
  if (!plan || !quote || quote.shop !== deps.config.shop) {
    await markDone(tx, [ev.id], deps.now());
    return "ignored";
  }
  return fanOut(tx, deps, ev, quote, plan);
}

async function markDone(tx: Tx, ids: string[], at: Date) {
  await tx.event.updateMany({ where: { id: { in: ids }, notifiedAt: null }, data: { notifiedAt: at } });
}

// ------------------------------------------------------------------------------------------------ fan-out

interface NotifyState {
  attempts: number;
  sent: string[];
  nextAttemptAt?: string;
  /** NEW_MESSAGE consumed without sending anything (only internal notes): does not start a bundling window. */
  ignored?: boolean;
}
const readState = (payload: unknown): NotifyState => {
  const n = asObj(asObj(payload)._notify);
  return { attempts: typeof n.attempts === "number" ? n.attempts : 0, sent: Array.isArray(n.sent) ? n.sent.filter((x): x is string => typeof x === "string") : [] };
};
const writeState = (tx: Tx, ev: Event, s: NotifyState) =>
  tx.event.update({ where: { id: ev.id }, data: { payload: json({ ...asObj(ev.payload), _notify: s }) } });

async function fanOut(tx: Tx, deps: WorkerDeps, ev: Event, quote: Quote, plan: NotifyPlan): Promise<EventOutcome> {
  const { config } = deps;
  const now = deps.now();
  const state = readState(ev.payload);
  const siblingIds: string[] = [];
  let messages: Message[] | undefined;

  if (ev.type === "NEW_MESSAGE") {
    // Bundling: the first alert goes out at once; further messages on the same quote within the window wait and leave as ONE alert
    // once the window has passed.
    const side = plan.sides[0]!;
    void side;
    // A NEW_MESSAGE event of the same author side that was fanned out inside the window started it.
    const recent = await tx.event.findMany({
      where: { quoteId: quote.id, type: "NEW_MESSAGE", actorType: ev.actorType, id: { not: ev.id }, notifiedAt: { gt: new Date(now.getTime() - config.bundleWindowMs) } },
      orderBy: { notifiedAt: "desc" },
      take: 10,
    });
    const last = recent.find((r) => !readState(r.payload).ignored);
    if (last) {
      await writeState(tx, ev, { ...state, nextAttemptAt: iso(new Date(last.notifiedAt!.getTime() + config.bundleWindowMs)) });
      return "held";
    }
    const siblings = await tx.event.findMany({ where: { quoteId: quote.id, type: "NEW_MESSAGE", actorType: ev.actorType, notifiedAt: null, id: { not: ev.id } } });
    siblingIds.push(...siblings.map((s) => s.id));
    const ids = [ev, ...siblings].map((e) => asObj(e.payload).messageId).filter((x): x is string => typeof x === "string");
    // Internal notes are filtered here as well as at the source (the API never emits an event for them): rule 5.
    messages = await tx.message.findMany({ where: { id: { in: ids }, quoteId: quote.id, internal: false }, orderBy: { createdAt: "asc" } });
    if (messages.length === 0) {
      for (const e of [ev, ...siblings]) await writeState(tx, e, { ...readState(e.payload), ignored: true });
      await markDone(tx, [ev.id, ...siblingIds], now);
      return "ignored";
    }
  }

  const base = await buildContext(tx, deps, ev, quote, plan, messages);
  let retryable = 0;
  const sent = new Set(state.sent);

  for (const side of plan.sides) {
    const recipients = await resolveRecipients(tx, config, quote, side, plan, { excludeStaffId: ev.actorType === "STAFF" ? ev.actorId : null });
    for (const r of recipients) {
      const ctx: TemplateCtx = { ...base, side, canReplyByEmail: true };
      if (r.smsWithoutOptIn) deps.log.info("watcher asked for texts but has no opt-in on file; not texted", { quoteId: quote.id, watcher: r.key });
      if (r.emailOn && r.email) {
        const key = `email:${side}:${r.key}`;
        if (!sent.has(key)) {
          const res = await sendEmail(tx, deps, ev, quote, plan, side, r, ctx);
          if (res === "retry") retryable++;
          else sent.add(key);
        }
      }
      if (r.phone) {
        const key = `sms:${side}:${r.key}`;
        if (!sent.has(key)) {
          const res = await sendSms(tx, deps, ev, quote, plan, side, r, ctx);
          if (res === "retry") retryable++;
          else sent.add(key);
        }
      }
    }
  }

  if (retryable > 0 && state.attempts + 1 < config.maxAttempts) {
    const delay = config.retryBackoffMs * 2 ** state.attempts;
    await writeState(tx, ev, { attempts: state.attempts + 1, sent: [...sent], nextAttemptAt: iso(new Date(now.getTime() + delay)) });
    return "retry";
  }
  if (retryable > 0) deps.log.error("giving up on notification after repeated provider failures", { eventId: ev.id, attempts: state.attempts + 1 });
  await markDone(tx, [ev.id, ...siblingIds], now);
  return "sent";
}

async function buildContext(tx: Tx, deps: WorkerDeps, ev: Event, quote: Quote, plan: NotifyPlan, messages?: Message[]): Promise<Omit<TemplateCtx, "side" | "canReplyByEmail">> {
  const payload = asObj(ev.payload);
  let repNote: string | null = null;
  let actorName: string | null = null;
  let floor: TemplateCtx["floor"];
  if (plan.template === "quote_ready") {
    const v = await tx.quoteVersion.findUnique({ where: { quoteId_versionNo: { quoteId: quote.id, versionNo: quote.currentVersion } } });
    repNote = v?.repNote ?? null;
    if (ev.actorId) actorName = (await tx.staff.findUnique({ where: { id: ev.actorId } }))?.name ?? null;
  }
  if (plan.template === "floor_approval") {
    // Payload written by POST /s/quotes/{id}/request-floor-approval: lineIds, costUnknownLineIds, note, requester {id, name}.
    const lineIds = Array.isArray(payload.lineIds) ? payload.lineIds.filter((x): x is string => typeof x === "string") : [];
    const unknownIds = Array.isArray(payload.costUnknownLineIds) ? payload.costUnknownLineIds.filter((x): x is string => typeof x === "string") : [];
    const lines = lineIds.length ? await tx.quoteLine.findMany({ where: { id: { in: lineIds }, quoteId: quote.id }, orderBy: { position: "asc" }, select: { sku: true, title: true } }) : [];
    const requester = asObj(payload.requester);
    const requesterName = typeof requester.name === "string" ? requester.name : ev.actorId ? ((await tx.staff.findUnique({ where: { id: ev.actorId } }))?.name ?? "A rep") : "A rep";
    floor = { requester: requesterName, note: typeof payload.note === "string" && payload.note.trim() ? payload.note : null, lines, costUnknownCount: unknownIds.length };
    actorName = requesterName;
  }
  return {
    template: plan.template,
    number: quote.number,
    title: quote.title,
    customerName: quote.customerName,
    companyName: quote.companyName,
    version: quote.currentVersion,
    total: quote.total.toFixed(2),
    expiresAt: quote.expiresAt,
    // `link` is filled per side below.
    link: "",
    repNote,
    changeRequest: typeof payload.message === "string" ? payload.message : null,
    actorName,
    expired: plan.expired,
    orderRef: typeof payload.orderName === "string" ? payload.orderName : null,
    ...(floor ? { floor } : {}),
    ...(messages ? { messages: messages.map((m) => ({ author: m.authorName ?? (m.authorType === "STAFF" ? "DSG Sales" : "Customer"), body: m.body, at: m.createdAt })) } : {}),
  };
}

/** Customer links use APP_PUBLIC_URL (the storefront app proxy); staff and manager links open the admin. */
const linkFor = (deps: WorkerDeps, quoteId: string, side: Side) =>
  side === "customer" ? `${deps.config.appPublicUrl}/quotes/${quoteId}` : `${deps.config.adminQuoteUrl}/${quoteId}`;

// ------------------------------------------------------------------------------------------------ send log

export type SendStatus = "SENT" | "FAILED" | "OPTED_OUT" | "SKIPPED_SMS_DISABLED" | "SKIPPED_OPTED_OUT" | "SKIPPED_NO_OPT_IN" | "SKIPPED_QUIET_HOURS";

/** Everything the send paths know about one attempt. Only `quoteId`, channel, `to`, status and provider id reach `NotificationLog`. */
interface SendFields {
  template: string;
  side: Side;
  channel: "email" | "sms";
  to: string;
  recipientKind: string;
  recipientKey: string;
}

/** One `NotificationLog` row per attempt (email or SMS), with the provider id for sends. */
async function writeLog(tx: Tx, deps: WorkerDeps, quoteId: string | null, f: SendFields, status: SendStatus, extra: { providerId?: string; error?: string } = {}) {
  deps.log.info("notification", { quoteId, ...f, status, ...extra });
  await tx.notificationLog.create({
    data: { quoteId, channel: f.channel === "email" ? "EMAIL" : "SMS", to: f.to, status, providerId: extra.providerId ?? null, createdAt: deps.now() },
  });
}

async function sendEmail(tx: Tx, deps: WorkerDeps, ev: Event, quote: Quote, plan: NotifyPlan, side: Side, r: Recipient, ctx: TemplateCtx): Promise<"done" | "retry"> {
  const { config } = deps;
  const rendered = renderEmail({ ...ctx, link: linkFor(deps, quote.id, side) });
  const fields: SendFields = { template: plan.template, side, channel: "email", to: r.email!, recipientKind: r.kind, recipientKey: r.key };
  try {
    const res = await deps.email.send({
      from: config.emailFrom,
      to: r.email!,
      ...(r.cc ? { cc: [r.cc] } : {}),
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      replyTo: replyAddress({ secret: config.replySecret, domain: config.replyDomain, quoteId: quote.id, role: r.replyRole }),
      tag: plan.template,
      metadata: { quoteId: quote.id, eventId: ev.id },
    });
    await writeLog(tx, deps, quote.id, fields, "SENT", { providerId: res.providerId });
    return "done";
  } catch (e) {
    const retry = !(e instanceof ProviderError) || e.retryable;
    if (retry) {
      deps.log.warn("email send failed, will retry", { eventId: ev.id, to: r.email, error: (e as Error).message });
      return "retry";
    }
    await writeLog(tx, deps, quote.id, fields, "FAILED", { error: (e as Error).message });
    return "done";
  }
}

async function sendSms(tx: Tx, deps: WorkerDeps, ev: Event, quote: Quote, plan: NotifyPlan, side: Side, r: Recipient, ctx: TemplateCtx): Promise<"done" | "retry"> {
  const body = renderSms({ ...ctx, link: linkFor(deps, quote.id, side) });
  const fields: SendFields = { template: plan.template, side, channel: "sms", to: r.phone!, recipientKind: r.kind, recipientKey: r.key };
  if (r.smsOptedOut) {
    // STOP is recorded in SmsOptOut and outranks every preference row.
    await writeLog(tx, deps, quote.id, fields, "SKIPPED_OPTED_OUT");
    return "done";
  }
  if (!deps.sms) {
    await writeLog(tx, deps, quote.id, fields, "SKIPPED_SMS_DISABLED");
    return "done";
  }
  const now = deps.now();
  if (r.quiet && inQuietHours(now, r.quiet)) {
    // Quiet hours defer SMS only; the email for the same event has already gone out.
    const sendAfter = iso(quietEndsAt(now, r.quiet));
    await tx.event.create({
      data: { quoteId: quote.id, type: DEFERRED_TYPE, actorType: "SYSTEM", payload: json({ ...fields, body, sendAfter }), createdAt: now },
    });
    await writeLog(tx, deps, quote.id, fields, "SKIPPED_QUIET_HOURS");
    deps.log.info("sms deferred for quiet hours", { quoteId: quote.id, to: r.phone, sendAfter });
    return "done";
  }
  return deliverSms(tx, deps, quote.id, fields, body);
}

async function deliverSms(tx: Tx, deps: WorkerDeps, quoteId: string, fields: SendFields, body: string): Promise<"done" | "retry"> {
  try {
    const res = await deps.sms!.send({ to: fields.to, body });
    await writeLog(tx, deps, quoteId, fields, "SENT", { providerId: res.providerId });
    return "done";
  } catch (e) {
    if (e instanceof ProviderError && e.code === TWILIO_UNSUBSCRIBED) {
      // Carrier-level STOP we never heard about (e.g. the Messaging Service handled it): honour it in our own records.
      await optOutPhone(tx, deps.config.shop, fields.to, { source: "twilio-21610", quoteId, now: deps.now() });
      await writeLog(tx, deps, quoteId, fields, "OPTED_OUT", { error: e.message });
      return "done";
    }
    if (!(e instanceof ProviderError) || e.retryable) {
      deps.log.warn("sms send failed, will retry", { to: fields.to, error: (e as Error).message });
      return "retry";
    }
    await writeLog(tx, deps, quoteId, fields, "FAILED", { error: (e as Error).message });
    return "done";
  }
}

// ------------------------------------------------------------------------------------------------ deferred SMS

/** Send (or drop) a text that waited out quiet hours. The queue entry is deleted either way; the outcome is a NotificationLog row. */
async function sendDeferred(tx: Tx, deps: WorkerDeps, ev: Event): Promise<EventOutcome> {
  const p = asObj(ev.payload);
  const to = String(p.to ?? "");
  const fields: SendFields = {
    template: String(p.template ?? ""),
    side: (p.side as Side) ?? "customer",
    channel: "sms",
    to,
    recipientKind: String(p.recipientKind ?? ""),
    recipientKey: String(p.recipientKey ?? ""),
  };
  const finish = async (status: SendStatus, extra: { providerId?: string; error?: string } = {}) => {
    await writeLog(tx, deps, ev.quoteId, fields, status, extra);
    await tx.event.delete({ where: { id: ev.id } });
  };

  // Consent may have been revoked, or a STOP received, while the text was waiting for morning.
  const consent =
    p.recipientKind === "staff"
      ? await tx.notificationPref.count({ where: { staffId: String(p.recipientKey), smsOptInAt: { not: null }, sms: true } })
      : await tx.notificationPref.count({ where: { customerId: String(p.recipientKey), smsOptInAt: { not: null }, sms: true } });
  if (await isSmsOptedOut(tx, to)) {
    await finish("SKIPPED_OPTED_OUT");
    return "deferred_cancelled";
  }
  if (consent === 0) {
    await finish("SKIPPED_NO_OPT_IN");
    return "deferred_cancelled";
  }
  if (!deps.sms) {
    await finish("SKIPPED_SMS_DISABLED");
    return "deferred_cancelled";
  }
  const state = readState(ev.payload);
  try {
    const res = await deps.sms.send({ to, body: String(p.body ?? "") });
    await finish("SENT", { providerId: res.providerId });
    return "deferred_sent";
  } catch (e) {
    if (e instanceof ProviderError && e.code === TWILIO_UNSUBSCRIBED) {
      await optOutPhone(tx, deps.config.shop, to, { source: "twilio-21610", quoteId: ev.quoteId, now: deps.now() });
      await finish("OPTED_OUT", { error: e.message });
      return "deferred_cancelled";
    }
    const retryable = !(e instanceof ProviderError) || e.retryable;
    if (retryable && state.attempts + 1 < deps.config.maxAttempts) {
      await writeState(tx, ev, { attempts: state.attempts + 1, sent: [], nextAttemptAt: iso(new Date(deps.now().getTime() + deps.config.retryBackoffMs * 2 ** state.attempts)) });
      return "retry";
    }
    await finish("FAILED", { error: (e as Error).message });
    return "deferred_cancelled";
  }
}
