import type { NotificationPref, PrismaClient, Quote, Staff } from "@prisma/client";
import type { NotifyConfig } from "./config";
import { extractEmail } from "./lib/reply-token";
import { normalizePhone } from "./lib/phone";
import type { ReplyRole } from "./lib/reply-token";
import type { Side } from "./rules";

export interface Recipient {
  kind: "customer" | "watcher" | "staff";
  /** Stable id used for idempotency keys and replies: customerId | staffId | watcher email | "fallback". */
  key: string;
  name: string;
  email: string | null;
  emailOn: boolean;
  /** E.164, only set when SMS is allowed: pref.sms AND smsOptInAt AND a valid phone. */
  phone: string | null;
  quiet: { start: string | null; end: string | null; tz: string | null } | null;
  replyRole: ReplyRole;
}

type Db = Pick<PrismaClient, "notificationPref" | "staff" | "customerProfile">;

const asStrings = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.flatMap((x) => (typeof x === "string" ? [x] : x && typeof x === "object" && typeof (x as { email?: unknown }).email === "string" ? [(x as { email: string }).email] : []))
    : [];

/** Defaults match GET /c/notification-prefs: email on, SMS off. */
function pickPref(rows: NotificationPref[], prefKey: string, fallbackPhone?: string | null) {
  const row = rows.find((r) => r.event === prefKey) ?? null;
  // Opt-in, phone and quiet hours are stored (replicated) on every row of the person; take them from the row that has them.
  const contact = rows.find((r) => r.smsOptInAt && r.phone) ?? row ?? rows[0] ?? null;
  const emailOn = row ? row.email : true;
  const smsOn = !!row && row.sms && !!contact?.smsOptInAt;
  const phone = smsOn ? normalizePhone(contact?.phone ?? fallbackPhone) : null;
  const quiet = contact ? { start: contact.quietStart, end: contact.quietEnd, tz: contact.timezone } : null;
  return { emailOn, phone, quiet };
}

export async function resolveRecipients(db: Db, config: NotifyConfig, quote: Quote, side: Side, prefKey: string): Promise<Recipient[]> {
  return side === "customer" ? customerRecipients(db, config, quote, prefKey) : salesRecipients(db, config, quote, prefKey);
}

async function customerRecipients(db: Db, config: NotifyConfig, quote: Quote, prefKey: string): Promise<Recipient[]> {
  const shop = config.shop;
  const [rows, profile] = await Promise.all([
    db.notificationPref.findMany({ where: { shop, customerId: quote.customerId } }),
    db.customerProfile.findUnique({ where: { shop_customerId: { shop, customerId: quote.customerId } } }),
  ]);
  const pref = pickPref(rows, prefKey);
  const ownerEmail = extractEmail(profile?.email) ?? extractEmail(quote.customerEmail);
  const out: Recipient[] = [
    {
      kind: "customer",
      key: quote.customerId,
      name: quote.customerName,
      email: ownerEmail,
      emailOn: pref.emailOn && !!ownerEmail,
      phone: pref.phone,
      quiet: pref.quiet,
      replyRole: "c",
    },
  ];
  // Watchers ("also notify"): email only, and only for events the owner has email switched on for.
  const seen = new Set(ownerEmail ? [ownerEmail] : []);
  for (const raw of [...asStrings(quote.watchers), ...asStrings(profile?.watchers)]) {
    const e = extractEmail(raw);
    if (!e || seen.has(e)) continue;
    seen.add(e);
    out.push({ kind: "watcher", key: e, name: e, email: e, emailOn: pref.emailOn, phone: null, quiet: null, replyRole: "c" });
  }
  return out;
}

async function salesRecipients(db: Db, config: NotifyConfig, quote: Quote, prefKey: string): Promise<Recipient[]> {
  const shop = config.shop;
  let staff: Staff[] = [];
  if (quote.assignedRepId) staff = await db.staff.findMany({ where: { id: quote.assignedRepId, shop } });
  if (staff.length === 0 && quote.teamId) staff = await db.staff.findMany({ where: { shop, teamId: quote.teamId } });
  if (staff.length === 0) staff = await db.staff.findMany({ where: { shop, isManager: true } });

  const out: Recipient[] = [];
  if (staff.length) {
    const prefs = await db.notificationPref.findMany({ where: { shop, staffId: { in: staff.map((s) => s.id) } } });
    for (const s of staff) {
      const p = pickPref(prefs.filter((r) => r.staffId === s.id), prefKey, s.phone);
      // Staff have no settings screen yet: a staff pref row with sms + smsOptInAt (and a phone) switches texts on; email defaults on.
      const email = extractEmail(s.email);
      out.push({ kind: "staff", key: s.id, name: s.name, email, emailOn: p.emailOn && !!email, phone: p.phone, quiet: p.quiet, replyRole: "s" });
    }
  } else if (config.salesFallbackEmail) {
    out.push({ kind: "staff", key: "fallback", name: "Sales", email: extractEmail(config.salesFallbackEmail), emailOn: true, phone: null, quiet: null, replyRole: "s" });
  }
  return out;
}
