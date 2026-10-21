import type { RenderedEmail } from "./templates";

export interface WeeklySummaryQuote {
  number: number;
  title: string;
  status: string;
  total: string;
  expiresAt: Date | null;
  link: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = (v: string) => `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d: Date | null) => (d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" }) : null);

const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: "With our sales team",
  IN_REVIEW: "With our sales team",
  CHANGES_REQUESTED: "With our sales team",
  QUOTE_READY: "Ready for your review",
  ACCEPTED: "Accepted, ready to buy",
};

/** Monday WEEKLY_SUMMARY email: the customer's open quotes, customer-visible figures only (no cost, margin or internal notes). */
export function renderWeeklySummary(c: { name: string; quotes: WeeklySummaryQuote[]; link: string; supportEmail: string }): RenderedEmail {
  const n = c.quotes.length;
  const rows = c.quotes.map((q) => {
    const exp = day(q.expiresAt);
    const label = STATUS_LABEL[q.status] ?? q.status;
    return { q, exp, label, text: `Q-${q.number}  ${q.title} - ${label}, ${money(q.total)}${exp ? `, held until ${exp}` : ""}` };
  });
  const subject = `Your weekly quote summary: ${n} open quote${n === 1 ? "" : "s"}`;
  const text = [
    `Hi ${c.name || "there"},`,
    "",
    "Here are your open quotes with DSG Distributors:",
    "",
    ...rows.flatMap((r) => [`  ${r.text}`, `    ${r.q.link}`]),
    "",
    `All your quotes: ${c.link}`,
    "",
    `You can turn this summary off under My Quotes > Notification settings. Questions? ${c.supportEmail}`,
    "",
    "DSG Distributors",
  ].join("\n");
  const items = rows
    .map(
      (r) =>
        `<li style="margin:0 0 8px;font-size:15px"><a href="${esc(r.q.link)}">Q-${r.q.number}</a> ${esc(r.q.title)}<br><span style="color:#5c6670;font-size:13px">${esc(r.label)} &middot; ${esc(money(r.q.total))}${r.exp ? ` &middot; held until ${esc(r.exp)}` : ""}</span></li>`,
    )
    .join("");
  const html = `<!doctype html><html><body style="margin:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1c2330">
<div style="max-width:560px;margin:0 auto;padding:24px 16px"><div style="background:#fff;border:1px solid #dfe3e8;border-radius:8px;padding:24px">
<h1 style="font-size:18px;margin:0 0 12px">Your open quotes</h1>
<p style="margin:0 0 12px;font-size:15px">Hi ${esc(c.name || "there")}, here is where your ${n} open quote${n === 1 ? "" : "s"} stand.</p>
<ul style="padding-left:18px;margin:0 0 12px">${items}</ul>
<p style="margin:20px 0 4px"><a href="${esc(c.link)}" style="background:#1A6FB5;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:15px;display:inline-block">View all quotes</a></p>
</div><p style="font-size:12px;color:#5c6670;margin:12px 4px">Turn this summary off under My Quotes &gt; Notification settings. DSG Distributors</p></div></body></html>`;
  return { subject, text, html };
}
