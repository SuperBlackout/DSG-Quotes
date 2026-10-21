import type { AuthorType, Prisma } from "@prisma/client";

/** Shared by the inbound hooks (apps/api/src/hooks) and the processor. Everything takes the caller's transaction client. */
export type Tx = Prisma.TransactionClient;

/**
 * Post a reply that arrived by email or SMS into the quote conversation (never internal) and emit the NEW_MESSAGE event the
 * worker fans out. Mirrors POST /c|/s/quotes/:id/messages: Message row + NEW_MESSAGE event + quote.updatedAt bump.
 */
export async function recordInboundMessage(
  tx: Tx,
  input: {
    quoteId: string;
    authorType: Exclude<AuthorType, "SYSTEM">;
    authorId: string | null;
    authorName: string | null;
    body: string;
    channel: "EMAIL" | "SMS";
    now: Date;
  },
) {
  const message = await tx.message.create({
    data: {
      quoteId: input.quoteId,
      authorType: input.authorType,
      authorId: input.authorId,
      authorName: input.authorName,
      body: input.body,
      internal: false,
      channel: input.channel,
      createdAt: input.now,
    },
  });
  await tx.event.create({
    data: {
      quoteId: input.quoteId,
      type: "NEW_MESSAGE",
      actorType: input.authorType,
      actorId: input.authorId,
      payload: { messageId: message.id, channel: input.channel },
      createdAt: input.now,
    },
  });
  await tx.quote.update({ where: { id: input.quoteId }, data: { updatedAt: input.now } });
  return message;
}

/** True when this number replied STOP (or was opted out another way) and has not texted START since. Never text such a number. */
export async function isSmsOptedOut(db: Pick<Tx, "smsOptOut">, phone: string | null | undefined): Promise<boolean> {
  if (!phone) return false;
  return (await db.smsOptOut.findUnique({ where: { phone }, select: { phone: true } })) !== null;
}

/**
 * STOP: record the opt-out in `SmsOptOut` (the source of truth: the sender checks it before every text, whatever the preference rows
 * say) and revoke SMS consent on every preference row holding this number (customers and staff). A history row goes to
 * `NotificationLog` (status OPTED_OUT). Re-subscribing needs an explicit START text (see `optInPhone`) AND fresh consent on the
 * notification settings screen: saving the settings form alone never lifts a STOP. Returns the preference rows changed.
 */
export async function optOutPhone(tx: Tx, shop: string, phone: string, opts: { source?: string; quoteId?: string | null; now?: Date } = {}): Promise<number> {
  const at = opts.now ?? new Date();
  const source = opts.source ?? "twilio-stop";
  await tx.smsOptOut.upsert({ where: { phone }, create: { phone, at, source }, update: { at, source } });
  await tx.notificationLog.create({ data: { quoteId: opts.quoteId ?? null, channel: "SMS", to: phone, status: "OPTED_OUT", providerId: null, createdAt: at } });
  const r = await tx.notificationPref.updateMany({ where: { shop, phone }, data: { sms: false, smsOptInAt: null } });
  // Staff whose texts go to Staff.phone (pref row carries no number of its own).
  const staff = await tx.staff.findMany({ where: { shop, phone }, select: { id: true } });
  let n = r.count;
  if (staff.length) {
    n += (await tx.notificationPref.updateMany({ where: { shop, staffId: { in: staff.map((s) => s.id) } }, data: { sms: false, smsOptInAt: null } })).count;
  }
  return n;
}

/**
 * START (UNSTOP/YES): the person explicitly asked to be texted again, so the number leaves `SmsOptOut` (history stays in
 * `NotificationLog`, status OPTED_IN_START). Consent on the preference rows stays cleared: they must still opt in on the settings screen.
 */
export async function optInPhone(tx: Tx, phone: string, opts: { now?: Date } = {}): Promise<boolean> {
  const removed = await tx.smsOptOut.deleteMany({ where: { phone } });
  if (removed.count > 0) await tx.notificationLog.create({ data: { quoteId: null, channel: "SMS", to: phone, status: "OPTED_IN_START", providerId: null, createdAt: opts.now ?? new Date() } });
  return removed.count > 0;
}
