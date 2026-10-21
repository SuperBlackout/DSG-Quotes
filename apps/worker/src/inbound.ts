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

/**
 * STOP: revoke SMS consent for every preference row holding this number (customers and staff). Clearing `smsOptInAt` is the
 * stored opt-out: the recipient resolver never texts a number without it, and re-subscribing requires the customer to opt in again
 * on the notification settings screen (new consent timestamp + wording). Returns the rows changed.
 */
export async function optOutPhone(tx: Tx, shop: string, phone: string): Promise<number> {
  const r = await tx.notificationPref.updateMany({ where: { shop, phone }, data: { sms: false, smsOptInAt: null } });
  // Staff whose texts go to Staff.phone (pref row carries no number of its own).
  const staff = await tx.staff.findMany({ where: { shop, phone }, select: { id: true } });
  let n = r.count;
  if (staff.length) {
    n += (await tx.notificationPref.updateMany({ where: { shop, staffId: { in: staff.map((s) => s.id) } }, data: { sms: false, smsOptInAt: null } })).count;
  }
  return n;
}
