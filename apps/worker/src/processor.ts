import { Prisma, type Event, type Message, type Quote } from "@prisma/client";
import type { WorkerDeps } from "./config";
import { optOutPhone } from "./inbound";
import { replyAddress } from "./lib/reply-token";
import { inQuietHours, quietEndsAt } from "./lib/quiet-hours";
import { ProviderError } from "./providers/types";
import { TWILIO_UNSUBSCRIBED } from "./providers/twilio";
import { resolveRecipients, type Recipient } from "./recipients";
import { planFor, type NotifyPlan, type Side } from "./rules";
import { renderEmail, renderSms, type TemplateCtx } from "./templates";

type Tx = Prisma.TransactionClient;
type Json = Record<string, unknown>;

/** `Event.type` of the per-send log rows (one per channel per recipient, with the provider id). */
export const LOG_TYPE = "NOTIFICATION";
/** An SMS held back by quiet hours. Unprocessed (`notifiedAt IS NULL`) until `payload.sendAfter`, then sent and turned into a log row. */
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
    const recent = await tx.event.findMany({
      where: {
        quoteId: quote.id,
        type: LOG_TYPE,
        createdAt: { gt: new Date(now.getTime() - config.bundleWindowMs) },
        AND: [{ payload: { path: ["template"], equals: "new_message" } }, { payload: { path: ["side"], equals: side } }],
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    const last = recent.find((r) => asObj(r.payload).status !== "FAILED" && asObj(r.payload).status !== "SKIPPED");
    if (last) {
      await writeState(tx, ev, { ...state, nextAttemptAt: iso(new Date(last.createdAt.getTime() + config.bundleWindowMs)) });
      return "held";
    }
    const siblings = await tx.event.findMany({ where: { quoteId: quote.id, type: "NEW_MESSAGE", actorType: ev.actorType, notifiedAt: null, id: { not: ev.id } } });
    siblingIds.push(...siblings.map((s) => s.id));
    const ids = [ev, ...siblings].map((e) => asObj(e.payload).messageId).filter((x): x is string => typeof x === "string");
    // Internal notes are filtered here as well as at the source (the API never emits an event for them): rule 5.
    messages = await tx.message.findMany({ where: { id: { in: ids }, quoteId: quote.id, internal: false }, orderBy: { createdAt: "asc" } });
    if (messages.length === 0) {
      await markDone(tx, [ev.id, ...siblingIds], now);
      return "ignored";
    }
  }

  const base = await buildContext(tx, deps, ev, quote, plan, messages);
  let retryable = 0;
  const sent = new Set(state.sent);

  for (const side of plan.sides) {
    const recipients = await resolveRecipients(tx, config, quote, side, plan.prefKey);
    for (const r of recipients) {
      const ctx: TemplateCtx = { ...base, side, canReplyByEmail: true };
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
  if (plan.template === "quote_ready") {
    const v = await tx.quoteVersion.findUnique({ where: { quoteId_versionNo: { quoteId: quote.id, versionNo: quote.currentVersion } } });
    repNote = v?.repNote ?? null;
    if (ev.actorId) actorName = (await tx.staff.findUnique({ where: { id: ev.actorId } }))?.name ?? null;
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
    ...(messages ? { messages: messages.map((m) => ({ author: m.authorName ?? (m.authorType === "STAFF" ? "DSG Sales" : "Customer"), body: m.body, at: m.createdAt })) } : {}),
  };
}

const linkFor = (deps: WorkerDeps, quoteId: string, side: Side) =>
  side === "customer" ? `${deps.config.appPublicUrl}/quotes/${quoteId}` : `${deps.config.adminQuoteUrl}/${quoteId}`;

interface LogFields {
  sourceEventId: string;
  template: string;
  side: Side;
  channel: "email" | "sms";
  to: string;
  recipientKind: string;
  recipientKey: string;
  status: "SENT" | "FAILED" | "SKIPPED" | "DEFERRED" | "OPTED_OUT";
  providerId?: string;
  error?: string;
  reason?: string;
}

async function writeLog(tx: Tx, deps: WorkerDeps, quoteId: string, f: LogFields) {
  const now = deps.now();
  deps.log.info("notification", { quoteId, ...f });
  return tx.event.create({
    data: { quoteId, type: LOG_TYPE, actorType: "SYSTEM", payload: json({ ...f }), notifiedAt: now, createdAt: now },
  });
}

async function sendEmail(tx: Tx, deps: WorkerDeps, ev: Event, quote: Quote, plan: NotifyPlan, side: Side, r: Recipient, ctx: TemplateCtx): Promise<"done" | "retry"> {
  const { config } = deps;
  const rendered = renderEmail({ ...ctx, link: linkFor(deps, quote.id, side) });
  const fields = { sourceEventId: ev.id, template: plan.template, side, channel: "email" as const, to: r.email!, recipientKind: r.kind, recipientKey: r.key };
  try {
    const res = await deps.email.send({
      from: config.emailFrom,
      to: r.email!,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      replyTo: replyAddress({ secret: config.replySecret, domain: config.replyDomain, quoteId: quote.id, role: r.replyRole }),
      tag: plan.template,
      metadata: { quoteId: quote.id, eventId: ev.id },
    });
    await writeLog(tx, deps, quote.id, { ...fields, status: "SENT", providerId: res.providerId });
    return "done";
  } catch (e) {
    const retry = !(e instanceof ProviderError) || e.retryable;
    if (retry) {
      deps.log.warn("email send failed, will retry", { eventId: ev.id, to: r.email, error: (e as Error).message });
      return "retry";
    }
    await writeLog(tx, deps, quote.id, { ...fields, status: "FAILED", error: (e as Error).message });
    return "done";
  }
}

async function sendSms(tx: Tx, deps: WorkerDeps, ev: Event, quote: Quote, plan: NotifyPlan, side: Side, r: Recipient, ctx: TemplateCtx): Promise<"done" | "retry"> {
  const body = renderSms({ ...ctx, link: linkFor(deps, quote.id, side) });
  const fields = { sourceEventId: ev.id, template: plan.template, side, channel: "sms" as const, to: r.phone!, recipientKind: r.kind, recipientKey: r.key };
  if (!deps.sms) {
    await writeLog(tx, deps, quote.id, { ...fields, status: "SKIPPED", reason: "sms_disabled" });
    return "done";
  }
  const now = deps.now();
  if (r.quiet && inQuietHours(now, r.quiet)) {
    // Quiet hours defer SMS only; the email for the same event has already gone out.
    const sendAfter = iso(quietEndsAt(now, r.quiet));
    await tx.event.create({
      data: { quoteId: quote.id, type: DEFERRED_TYPE, actorType: "SYSTEM", payload: json({ ...fields, status: "DEFERRED", body, sendAfter }), createdAt: now },
    });
    deps.log.info("sms deferred for quiet hours", { quoteId: quote.id, to: r.phone, sendAfter });
    return "done";
  }
  return deliverSms(tx, deps, quote.id, fields, body);
}

async function deliverSms(tx: Tx, deps: WorkerDeps, quoteId: string, fields: Omit<LogFields, "status">, body: string): Promise<"done" | "retry"> {
  try {
    const res = await deps.sms!.send({ to: fields.to, body });
    await writeLog(tx, deps, quoteId, { ...fields, status: "SENT", providerId: res.providerId });
    return "done";
  } catch (e) {
    if (e instanceof ProviderError && e.code === TWILIO_UNSUBSCRIBED) {
      // Carrier-level STOP we never heard about (e.g. the Messaging Service handled it): honour it in our own records.
      await optOutPhone(tx, deps.config.shop, fields.to);
      await writeLog(tx, deps, quoteId, { ...fields, status: "OPTED_OUT", error: e.message });
      return "done";
    }
    if (!(e instanceof ProviderError) || e.retryable) {
      deps.log.warn("sms send failed, will retry", { to: fields.to, error: (e as Error).message });
      return "retry";
    }
    await writeLog(tx, deps, quoteId, { ...fields, status: "FAILED", error: (e as Error).message });
    return "done";
  }
}

// ------------------------------------------------------------------------------------------------ deferred SMS

async function sendDeferred(tx: Tx, deps: WorkerDeps, ev: Event): Promise<EventOutcome> {
  const p = asObj(ev.payload);
  const now = deps.now();
  const to = String(p.to ?? "");
  const finish = async (status: string, extra: Json) => {
    await tx.event.update({
      where: { id: ev.id },
      data: { type: LOG_TYPE, notifiedAt: now, createdAt: now, payload: json({ ...p, ...extra, status, sentAt: iso(now) }) },
    });
  };

  // Consent may have been revoked while the text was waiting for morning.
  const consent =
    p.recipientKind === "staff"
      ? await tx.notificationPref.count({ where: { staffId: String(p.recipientKey), smsOptInAt: { not: null }, sms: true } })
      : await tx.notificationPref.count({ where: { customerId: String(p.recipientKey), smsOptInAt: { not: null }, sms: true } });
  if (consent === 0 || !deps.sms) {
    await finish("SKIPPED", { reason: deps.sms ? "opted_out_before_send" : "sms_disabled" });
    return "deferred_cancelled";
  }
  const state = readState(ev.payload);
  try {
    const res = await deps.sms.send({ to, body: String(p.body ?? "") });
    await finish("SENT", { providerId: res.providerId });
    return "deferred_sent";
  } catch (e) {
    if (e instanceof ProviderError && e.code === TWILIO_UNSUBSCRIBED) {
      await optOutPhone(tx, deps.config.shop, to);
      await finish("OPTED_OUT", { error: e.message });
      return "deferred_cancelled";
    }
    const retryable = !(e instanceof ProviderError) || e.retryable;
    if (retryable && state.attempts + 1 < deps.config.maxAttempts) {
      await writeState(tx, ev, { attempts: state.attempts + 1, sent: [], nextAttemptAt: iso(new Date(now.getTime() + deps.config.retryBackoffMs * 2 ** state.attempts)) });
      return "retry";
    }
    await finish("FAILED", { error: (e as Error).message });
    return "deferred_cancelled";
  }
}
