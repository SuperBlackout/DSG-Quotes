import type { Quote } from "@prisma/client";
import type { WorkerDeps } from "../config";
import { usableEmail } from "../recipients";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const NEEDS_RESPONSE = ["SUBMITTED", "IN_REVIEW", "CHANGES_REQUESTED"];
const DAY = 86_400_000;

interface Section {
  title: string;
  quotes: Quote[];
}

const line = (deps: WorkerDeps, q: Quote, now: Date) => {
  const days = Math.max(0, Math.floor((now.getTime() - q.statusChangedAt.getTime()) / DAY));
  const who = q.companyName ?? q.customerName;
  return { text: `Q-${q.number}  ${q.title} (${who}) - ${days}d in ${q.status.toLowerCase().replace(/_/g, " ")}`, html: `<a href="${esc(`${deps.config.adminQuoteUrl}/${q.id}`)}">Q-${q.number}</a> ${esc(q.title)} (${esc(who)}) - ${days}d in ${esc(q.status.toLowerCase().replace(/_/g, " "))}` };
};

/**
 * Daily (after 8:00 ET): one email per rep listing quotes that need a response and quotes about to expire. Managers also get the
 * unassigned queue. Reps with nothing to act on get nothing. Email only (the digest is not a per-quote event). A rep can opt out
 * with a staff NotificationPref row `event = "DIGEST"`, `email = false`.
 */
export async function sendRepDigests(deps: WorkerDeps): Promise<{ sent: number; failed: number }> {
  const now = deps.now();
  const { shop } = deps.config;
  const soon = new Date(now.getTime() + 3 * DAY);
  const [staff, open, optOuts] = await Promise.all([
    deps.prisma.staff.findMany({ where: { shop, active: true } }),
    deps.prisma.quote.findMany({ where: { shop, deletedAt: null, status: { in: ["SUBMITTED", "IN_REVIEW", "CHANGES_REQUESTED", "QUOTE_READY", "ACCEPTED"] } }, orderBy: { statusChangedAt: "asc" } }),
    deps.prisma.notificationPref.findMany({ where: { shop, event: "DIGEST", email: false, staffId: { not: null } } }),
  ]);
  const off = new Set(optOuts.map((o) => o.staffId));
  let sent = 0;
  let failed = 0;

  for (const s of staff) {
    const to = usableEmail(s.email);
    if (!to || off.has(s.id)) continue;
    const mine = open.filter((q) => q.assignedRepId === s.id);
    const sections: Section[] = [
      { title: "Needs your response", quotes: mine.filter((q) => NEEDS_RESPONSE.includes(q.status)) },
      { title: "Expiring within 3 days", quotes: mine.filter((q) => (q.status === "QUOTE_READY" || q.status === "ACCEPTED") && q.expiresAt && q.expiresAt <= soon) },
      ...(s.role === "manager" || s.role === "admin" ? [{ title: "Unassigned", quotes: open.filter((q) => !q.assignedRepId && (q.status === "SUBMITTED" || q.status === "CHANGES_REQUESTED")) }] : []),
    ].filter((x) => x.quotes.length > 0);
    if (sections.length === 0) continue;

    const count = sections.reduce((n, x) => n + x.quotes.length, 0);
    const text = [`Good morning ${s.name},`, "", ...sections.flatMap((x) => [`${x.title} (${x.quotes.length})`, ...x.quotes.map((q) => `  ${line(deps, q, now).text}`), ""]), `Open the inbox: ${deps.config.adminQuoteUrl.replace(/\/quotes$/, "")}`].join("\n");
    const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1c2330"><p>Good morning ${esc(s.name)},</p>${sections
      .map((x) => `<h3 style="margin:16px 0 4px">${esc(x.title)} (${x.quotes.length})</h3><ul>${x.quotes.map((q) => `<li>${line(deps, q, now).html}</li>`).join("")}</ul>`)
      .join("")}</body></html>`;
    try {
      const res = await deps.email.send({
        from: deps.config.emailFrom,
        to,
        subject: `DSG Quotes: ${count} quote${count === 1 ? "" : "s"} for you today`,
        text,
        html,
        tag: "rep_digest",
        metadata: { staffId: s.id },
      });
      await deps.prisma.notificationLog.create({ data: { quoteId: null, channel: "EMAIL", to, status: "SENT", providerId: res.providerId, createdAt: deps.now() } });
      deps.log.info("rep digest sent", { staffId: s.id, to, providerId: res.providerId, quotes: count });
      sent++;
    } catch (e) {
      await deps.prisma.notificationLog.create({ data: { quoteId: null, channel: "EMAIL", to, status: "FAILED", providerId: null, createdAt: deps.now() } }).catch(() => undefined);
      deps.log.error("rep digest failed", { staffId: s.id, error: (e as Error).message });
      failed++;
    }
  }
  return { sent, failed };
}
