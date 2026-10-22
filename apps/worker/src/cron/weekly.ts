import type { Quote } from "@prisma/client";
import type { WorkerDeps } from "../config";
import { extractEmail } from "../lib/reply-token";
import { customerQuoteLink, parseWatchers, watcherApplies } from "../recipients";
import { renderWeeklySummary, type WeeklySummaryQuote } from "../templates-weekly";

/** Quotes still in play for the customer. Drafts are the customer's own scratch work and EXPIRED/ORDERED/DECLINED/ARCHIVED are done. */
export const WEEKLY_STATUSES = ["SUBMITTED", "IN_REVIEW", "CHANGES_REQUESTED", "QUOTE_READY", "ACCEPTED"] as const;

/**
 * Mondays after 8:00 ET: the WEEKLY_SUMMARY email. One email per customer who has open quotes and has not switched the
 * WEEKLY_SUMMARY email off (default on, like every event in GET /c/notification-prefs). Watchers receive the same summary
 * restricted to their scope (all quotes, or one job), when their own email channel is on and the owner has the summary on at all.
 * Email only; nothing is sent to someone with no open quotes in scope. Customer-visible figures only.
 */
export async function sendWeeklySummaries(deps: WorkerDeps): Promise<{ sent: number; failed: number }> {
  const { shop } = deps.config;
  const now = deps.now();
  const open = await deps.prisma.quote.findMany({
    where: { shop, deletedAt: null, status: { in: [...WEEKLY_STATUSES] }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    orderBy: [{ expiresAt: { sort: "asc", nulls: "last" } }, { number: "asc" }],
  });
  if (open.length === 0) return { sent: 0, failed: 0 };
  const byCustomer = new Map<string, Quote[]>();
  for (const q of open) byCustomer.set(q.customerId, [...(byCustomer.get(q.customerId) ?? []), q]);
  const customerIds = [...byCustomer.keys()];
  const [prefs, profiles] = await Promise.all([
    deps.prisma.notificationPref.findMany({ where: { shop, customerId: { in: customerIds }, event: "WEEKLY_SUMMARY" } }),
    deps.prisma.customerProfile.findMany({ where: { shop, customerId: { in: customerIds } } }),
  ]);

  const row = (q: Quote): WeeklySummaryQuote => ({ number: q.number, title: q.title, status: q.status, total: q.total.toFixed(2), expiresAt: q.expiresAt, link: customerQuoteLink(deps.config, q.id) });
  const listUrl = deps.config.customerQuotePageUrl || `${deps.config.appPublicUrl}/quotes`;
  let sent = 0;
  let failed = 0;
  const deliver = async (to: string, name: string, quotes: Quote[]) => {
    const mail = renderWeeklySummary({ name, quotes: quotes.map(row), link: listUrl, supportEmail: deps.config.supportEmail });
    try {
      const res = await deps.email.send({ from: deps.config.emailFrom, to, subject: mail.subject, text: mail.text, html: mail.html, tag: "weekly_summary", metadata: { quotes: String(quotes.length) } });
      await deps.prisma.notificationLog.create({ data: { quoteId: null, channel: "EMAIL", to, status: "SENT", providerId: res.providerId, createdAt: deps.now() } });
      deps.log.info("weekly summary sent", { to, providerId: res.providerId, quotes: quotes.length });
      sent++;
    } catch (e) {
      await deps.prisma.notificationLog.create({ data: { quoteId: null, channel: "EMAIL", to, status: "FAILED", providerId: null, createdAt: deps.now() } }).catch(() => undefined);
      deps.log.error("weekly summary failed", { to, error: (e as Error).message });
      failed++;
    }
  };

  for (const [customerId, quotes] of byCustomer) {
    const pref = prefs.find((p) => p.customerId === customerId) ?? null;
    const ownerEmailOn = pref ? pref.email : true;
    const ownerWants = ownerEmailOn || !!pref?.sms;
    if (!ownerWants) continue;
    const profile = profiles.find((p) => p.customerId === customerId);
    const ownerEmail = extractEmail(profile?.email) ?? quotes.map((q) => extractEmail(q.customerEmail)).find((e) => !!e) ?? null;
    const name = quotes[0]!.customerName;
    const seen = new Set<string>();

    if (ownerEmailOn && ownerEmail) {
      seen.add(ownerEmail);
      await deliver(ownerEmail, name, quotes);
    } else if (ownerEmail) {
      seen.add(ownerEmail);
    }

    // Watchers: per-email set of the quotes they follow (profile watchers by scope, quote-level watchers for that quote).
    const follow = new Map<string, { name: string; quotes: Map<string, Quote> }>();
    const add = (email: string, who: string, q: Quote) => {
      if (seen.has(email)) return;
      const e = follow.get(email) ?? { name: who, quotes: new Map<string, Quote>() };
      e.quotes.set(q.id, q);
      follow.set(email, e);
    };
    for (const w of parseWatchers(profile?.watchers)) if (w.channels.email) for (const q of quotes) if (watcherApplies(w, q)) add(w.email, w.name ?? "", q);
    for (const q of quotes) for (const w of parseWatchers(q.watchers)) if (w.channels.email) add(w.email, w.name ?? "", q);
    for (const [email, f] of follow) {
      const list = quotes.filter((q) => f.quotes.has(q.id));
      if (list.length) await deliver(email, f.name, list);
    }
  }
  return { sent, failed };
}
