import type { NotificationPref, PrismaClient, Quote, Staff } from "@prisma/client";
import type { NotifyConfig } from "./config";
import { isSmsOptedOut } from "./inbound";
import { extractEmail } from "./lib/reply-token";
import { normalizePhone } from "./lib/phone";
import type { ReplyRole } from "./lib/reply-token";
import type { NotifyPlan, Side } from "./rules";

export interface Recipient {
  kind: "customer" | "watcher" | "staff";
  /** Stable id used for idempotency keys and replies: customerId | staffId | watcher email | "fallback". */
  key: string;
  name: string;
  email: string | null;
  emailOn: boolean;
  /** E.164, only set when SMS is allowed: pref.sms AND smsOptInAt AND a valid phone. */
  phone: string | null;
  /** The number is in `SmsOptOut` (replied STOP): `phone` is kept so the skip can be logged, but nothing is ever sent to it. */
  smsOptedOut?: boolean;
  /** A watcher asked for text alerts (`channels.sms`) but has no number or opt-in of their own on file, so no text can go out. */
  smsWithoutOptIn?: boolean;
  quiet: { start: string | null; end: string | null; tz: string | null } | null;
  replyRole: ReplyRole;
  /** Address copied on this recipient's email (the shop's "copy all alerts to" setting). */
  cc?: string | null;
}

type Db = Pick<PrismaClient, "notificationPref" | "staff" | "customerProfile" | "smsOptOut" | "shopSetting">;

/** Placeholder addresses (".invalid" is reserved and never deliverable) count as "no email". */
export const usableEmail = (s: string | null | undefined): string | null => {
  const e = extractEmail(s);
  return e && !e.endsWith(".invalid") ? e : null;
};

/** The "copy all alerts to" address: the Settings value, else SALES_NOTIFY_EMAIL. */
async function copyAddress(db: Db, config: NotifyConfig): Promise<string | null> {
  const row = await db.shopSetting.findUnique({ where: { shop: config.shop }, select: { copyAllAlertsTo: true } });
  return usableEmail(row?.copyAllAlertsTo) ?? usableEmail(config.salesFallbackEmail);
}

/** A customer-side watcher in the shape the API stores (`Watcher`); legacy plain-email strings read as scope `all`, email only. */
export interface WatcherRule {
  email: string;
  name: string | null;
  /** `all` or a Job id. */
  scope: string;
  channels: { email: boolean; sms: boolean };
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Tolerant reader for `CustomerProfile.watchers` (objects) and `Quote.watchers` (emails, but objects are accepted too). */
export function parseWatchers(raw: unknown): WatcherRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x): WatcherRule[] => {
    if (typeof x === "string") {
      const email = extractEmail(x);
      return email ? [{ email, name: null, scope: "all", channels: { email: true, sms: false } }] : [];
    }
    const o = rec(x);
    const email = extractEmail(typeof o.email === "string" ? o.email : null);
    if (!email) return [];
    const ch = rec(o.channels);
    return [{ email, name: typeof o.name === "string" ? o.name : null, scope: typeof o.scope === "string" && o.scope ? o.scope : "all", channels: { email: ch.email !== false, sms: ch.sms === true } }];
  });
}

/** Scope `all` follows every quote of the customer; a job id follows only the quotes filed under that job. */
export const watcherApplies = (w: WatcherRule, quote: Pick<Quote, "jobId">) => w.scope === "all" || (!!quote.jobId && w.scope === quote.jobId);

/** Defaults match GET /c/notification-prefs: email on, SMS off. */
function pickPref(rows: NotificationPref[], prefKey: string, fallbackPhone?: string | null) {
  const row = rows.find((r) => r.event === prefKey) ?? null;
  // Opt-in, phone and quiet hours are stored (replicated) on every row of the person; take them from the row that has them.
  const contact = rows.find((r) => r.smsOptInAt && r.phone) ?? row ?? rows[0] ?? null;
  const emailOn = row ? row.email : true;
  const smsOn = !!row && row.sms && !!contact?.smsOptInAt;
  const phone = smsOn ? normalizePhone(contact?.phone ?? fallbackPhone) : null;
  const quiet = contact ? { start: contact.quietStart, end: contact.quietEnd, tz: contact.timezone } : null;
  return { emailOn, smsOn: row ? row.sms : false, phone, quiet };
}

export async function resolveRecipients(db: Db, config: NotifyConfig, quote: Quote, side: Side, plan: NotifyPlan, opts: { excludeStaffId?: string | null } = {}): Promise<Recipient[]> {
  if (side === "customer") return customerRecipients(db, config, quote, plan.customerPrefKey);
  if (side === "managers") return managerRecipients(db, config, plan, opts.excludeStaffId ?? null);
  return salesRecipients(db, config, quote, plan);
}

async function customerRecipients(db: Db, config: NotifyConfig, quote: Quote, prefKey: string | null): Promise<Recipient[]> {
  if (!prefKey) return []; // staff-bound events never reach the customer
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
      smsOptedOut: pref.phone ? await isSmsOptedOut(db, pref.phone) : false,
      quiet: pref.quiet,
      replyRole: "c",
    },
  ];
  // Watchers ("also notify") follow the owner's event selection (nothing if the owner switched the event off on every channel) and
  // then their own scope (all quotes or one job) and channels. A watcher's SMS needs that person's own opt-in; the contract stores
  // none (a Watcher has an email, no number), so a text is never sent to a watcher: it is recorded as skipped instead.
  const ownerWants = pref.emailOn || pref.smsOn;
  const seen = new Set(ownerEmail ? [ownerEmail] : []);
  // Quote-level watchers are explicit for this quote (scope does not apply); profile watchers are filtered by scope.
  const candidates = [...parseWatchers(quote.watchers).map((w) => ({ ...w, scope: "all" })), ...parseWatchers(profile?.watchers).filter((w) => watcherApplies(w, quote))];
  for (const w of candidates) {
    if (seen.has(w.email)) continue;
    seen.add(w.email);
    out.push({ kind: "watcher", key: w.email, name: w.name ?? w.email, email: w.email, emailOn: ownerWants && w.channels.email, phone: null, smsWithoutOptIn: ownerWants && w.channels.sms, quiet: null, replyRole: "c" });
  }
  return out;
}

const SALES_ROLES = ["manager", "admin"] as const;

async function staffRecipients(db: Db, shop: string, staff: Staff[], prefKey: string): Promise<Recipient[]> {
  if (staff.length === 0) return [];
  const prefs = await db.notificationPref.findMany({ where: { shop, staffId: { in: staff.map((s) => s.id) } } });
  const out: Recipient[] = [];
  for (const s of staff) {
    const p = pickPref(prefs.filter((r) => r.staffId === s.id), prefKey, s.phone);
    // Staff have no settings screen yet: a staff pref row with sms + smsOptInAt (and a phone) switches texts on; email defaults on.
    const email = usableEmail(s.email);
    out.push({ kind: "staff", key: s.id, name: s.name, email, emailOn: p.emailOn && !!email, phone: p.phone, smsOptedOut: p.phone ? await isSmsOptedOut(db, p.phone) : false, quiet: p.quiet, replyRole: "s" });
  }
  return out;
}

const fallbackFor = (copyTo: string | null): Recipient[] =>
  copyTo ? [{ kind: "staff", key: "fallback", name: "Sales", email: copyTo, emailOn: true, phone: null, quiet: null, replyRole: "s" }] : [];

/**
 * Sales-side email routing. Everyone resolved gets the mail with the shop's copy address on CC. If nobody resolved, or a resolved
 * person has no usable email, the copy address receives it directly (as the only recipient for that gap).
 */
async function withCopy(db: Db, config: NotifyConfig, out: Recipient[]): Promise<Recipient[]> {
  const copyTo = await copyAddress(db, config);
  if (!copyTo) return out;
  const gap = out.length === 0 || out.some((r) => r.kind === "staff" && !r.email);
  const kept = out.filter((r) => r.email).map((r) => ({ ...r, cc: r.email === copyTo ? null : copyTo }));
  const haveCopy = kept.some((r) => r.email === copyTo);
  // Recipients without an email still keep their other channels (texts); only email routing changes.
  const noEmail = out.filter((r) => !r.email);
  return [...kept, ...noEmail, ...(gap && !haveCopy ? fallbackFor(copyTo) : [])];
}

/** Assigned rep, else the quote's team (TeamMember), else every manager/admin. Inactive staff are never notified. The copy address rides along on CC. */
async function salesRecipients(db: Db, config: NotifyConfig, quote: Quote, plan: NotifyPlan): Promise<Recipient[]> {
  const shop = config.shop;
  let staff: Staff[] = [];
  if (quote.assignedRepId) staff = await db.staff.findMany({ where: { id: quote.assignedRepId, shop, active: true } });
  if (staff.length === 0 && quote.teamId) staff = await db.staff.findMany({ where: { shop, active: true, teams: { some: { teamId: quote.teamId } } } });
  if (staff.length === 0) staff = await db.staff.findMany({ where: { shop, active: true, role: { in: [...SALES_ROLES] } } });
  return withCopy(db, config, await staffRecipients(db, shop, staff, plan.salesPrefKey));
}

/** Active managers and admins (FLOOR_APPROVAL_REQUESTED). The requester is left out unless that would leave nobody. */
async function managerRecipients(db: Db, config: NotifyConfig, plan: NotifyPlan, excludeStaffId: string | null): Promise<Recipient[]> {
  const shop = config.shop;
  const all = await db.staff.findMany({ where: { shop, active: true, role: { in: [...SALES_ROLES] } }, orderBy: { name: "asc" } });
  const others = excludeStaffId ? all.filter((s) => s.id !== excludeStaffId) : all;
  return withCopy(db, config, await staffRecipients(db, shop, others, plan.salesPrefKey));
}
