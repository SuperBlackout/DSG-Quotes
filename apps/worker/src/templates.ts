import type { Side, Template } from "./rules";

export interface TemplateCtx {
  template: Template;
  side: Side;
  number: number;
  title: string;
  customerName: string;
  companyName: string | null;
  version: number;
  total: string | null; // decimal string, customer-visible total
  expiresAt: Date | null;
  link: string;
  /** Rep's customer-visible note on the sent version. */
  repNote?: string | null;
  /** Customer's change request text. */
  changeRequest?: string | null;
  /** Who did it (rep name for quote_ready, customer for accepted ...). */
  actorName?: string | null;
  /** new_message: bundled messages, oldest first. */
  messages?: { author: string; body: string; at: Date }[];
  expired?: boolean;
  /** Where "reply to this email" lands; shown as a hint when email replies are possible. */
  canReplyByEmail: boolean;
  orderRef?: string | null;
  /** floor_approval (managers only; never rendered for customers). No cost or margin figures: names and counts only. */
  floor?: { requester: string; note: string | null; lines: { sku: string | null; title: string }[]; costUnknownCount: number };
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const qn = (n: number) => `Q-${n}`;
const money = (v: string | null) => (v == null ? null : `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const day = (d: Date | null) => (d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" }) : null);
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const who = (c: TemplateCtx) => c.companyName ? `${c.customerName} (${c.companyName})` : c.customerName || "A customer";

interface Content {
  subject: string;
  headline: string;
  lines: string[]; // paragraphs
  quote?: string; // block quote (customer's words, rep note)
  cta: string;
}

function content(c: TemplateCtx): Content {
  const q = qn(c.number);
  const total = money(c.total);
  const exp = day(c.expiresAt);
  const forSales = c.side === "sales";
  switch (c.template) {
    case "submitted":
      return forSales
        ? {
            subject: `New quote request ${q}: ${c.title}`,
            headline: `${who(c)} submitted ${q}`,
            lines: [`"${c.title}" is waiting for pricing.${total ? ` Requested total: ${total}.` : ""}`],
            cta: "Open in admin",
          }
        : {
            subject: `We received your quote request ${q}`,
            headline: "Your quote request is with our sales team",
            lines: [`Thanks! "${c.title}" (${q}) was received. A rep will send pricing soon.`],
            cta: "View your quote",
          };
    case "quote_ready":
      return {
        subject: `Your quote ${q}${c.version > 1 ? ` (revision ${c.version})` : ""} is ready`,
        headline: c.version > 1 ? `${q} was revised (v${c.version})` : `${q} is ready to review`,
        lines: [
          `"${c.title}" has new pricing${total ? `: ${total}` : ""}.${exp ? ` Prices are held until ${exp}.` : ""}`,
          ...(c.actorName ? [`Prepared by ${c.actorName}.`] : []),
        ],
        quote: c.repNote ?? undefined,
        cta: "Review and accept",
      };
    case "new_message": {
      const n = c.messages?.length ?? 0;
      return {
        subject: forSales ? `${n > 1 ? `${n} new messages` : "New message"} on ${q} from ${c.customerName || "customer"}` : `${n > 1 ? `${n} new messages` : "New message"} about your quote ${q}`,
        headline: n > 1 ? `${n} new messages on ${q}` : `New message on ${q}`,
        lines: (c.messages ?? []).map((m) => `${m.author}: ${m.body}`),
        cta: "Open the conversation",
      };
    }
    case "changes_requested":
      return {
        subject: `Changes requested on ${q}`,
        headline: `${who(c)} asked for changes to ${q}`,
        lines: [`"${c.title}" (v${c.version}) needs a revision.`],
        quote: c.changeRequest ?? undefined,
        cta: "Open in admin",
      };
    case "accepted":
      return forSales
        ? {
            subject: `${q} was accepted`,
            headline: `${who(c)} accepted ${q}`,
            lines: [`"${c.title}" v${c.version}${total ? ` for ${total}` : ""} is accepted. They can now check out; you will be told when the order is placed.`],
            cta: "Open in admin",
          }
        : {
            subject: `You accepted quote ${q}`,
            headline: `Quote ${q} accepted`,
            lines: [`You accepted "${c.title}" v${c.version}${total ? ` (${total})` : ""}. Complete your purchase to lock in these prices${exp ? ` before ${exp}` : ""}.`],
            cta: "Buy now",
          };
    case "ordered":
      return forSales
        ? {
            subject: `Order placed from ${q}`,
            headline: `${who(c)} ordered from ${q}`,
            lines: [`"${c.title}" is now an order${c.orderRef ? ` (${c.orderRef})` : ""}.`],
            cta: "Open in admin",
          }
        : {
            subject: `Order confirmed from quote ${q}`,
            headline: "Your order is placed",
            lines: [`Thank you! Your order from "${c.title}" (${q}) is confirmed${c.orderRef ? ` (${c.orderRef})` : ""}.`],
            cta: "View your order",
          };
    case "floor_approval": {
      const n = c.floor?.lines.length ?? 0;
      const unknown = c.floor?.costUnknownCount ?? 0;
      const names = (c.floor?.lines ?? []).slice(0, 8).map((l) => `- ${l.sku ? `${l.sku} ` : ""}${l.title}`);
      return {
        subject: `Floor approval requested on ${q}`,
        headline: `${c.floor?.requester ?? "A rep"} needs approval to send ${q}`,
        lines: [
          `${n} line${n === 1 ? " is" : "s are"} below the price floor${unknown ? ` (${unknown} with unknown cost)` : ""} on "${c.title}" for ${who(c)}.`,
          ...names,
          ...(n > names.length ? [`...and ${n - names.length} more.`] : []),
        ],
        quote: c.floor?.note ?? undefined,
        cta: "Review and approve",
      };
    }
    case "expiring":
      return c.expired
        ? {
            subject: `Quote ${q} has expired`,
            headline: `${q} has expired`,
            lines: [`The prices on "${c.title}" are no longer held. Ask us for a refreshed quote any time.`],
            cta: "View your quote",
          }
        : {
            subject: `Quote ${q} expires${exp ? ` on ${exp}` : " soon"}`,
            headline: `${q} expires in about 3 days`,
            lines: [`"${c.title}"${total ? ` (${total})` : ""} is held${exp ? ` until ${exp}` : " for a few more days"}. Accept and buy before then to keep these prices.`],
            cta: "Review the quote",
          };
  }
}

export function renderEmail(c: TemplateCtx): RenderedEmail {
  const k = content(c);
  const hint = c.canReplyByEmail ? "Reply to this email to answer; your reply is added to the quote conversation." : "";
  const text = [
    k.headline,
    "",
    ...k.lines,
    ...(k.quote ? ["", ...k.quote.split("\n").map((l) => `> ${l}`)] : []),
    "",
    `${k.cta}: ${c.link}`,
    ...(hint ? ["", hint] : []),
    "",
    "DSG Distributors",
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1c2330">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<div style="background:#fff;border:1px solid #dfe3e8;border-radius:8px;padding:24px">
<h1 style="font-size:18px;margin:0 0 12px">${esc(k.headline)}</h1>
${k.lines.map((l) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.5">${esc(l)}</p>`).join("\n")}
${k.quote ? `<blockquote style="margin:12px 0;padding:8px 12px;border-left:3px solid #1A6FB5;background:#f4f8fc;font-size:14px;white-space:pre-wrap">${esc(k.quote)}</blockquote>` : ""}
<p style="margin:20px 0 4px"><a href="${esc(c.link)}" style="background:#1A6FB5;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:15px;display:inline-block">${esc(k.cta)}</a></p>
</div>
${hint ? `<p style="font-size:12px;color:#5c6670;margin:12px 4px">${esc(hint)}</p>` : ""}
<p style="font-size:12px;color:#5c6670;margin:12px 4px">DSG Distributors</p>
</div></body></html>`;
  return { subject: k.subject, text, html };
}

/** One short text plus the link. Kept to a single SMS segment where possible. */
export function renderSms(c: TemplateCtx): string {
  const q = qn(c.number);
  const total = money(c.total);
  const exp = day(c.expiresAt);
  const forSales = c.side === "sales";
  let body: string;
  switch (c.template) {
    case "submitted":
      body = forSales ? `DSG Quotes: ${clip(c.customerName || "A customer", 24)} submitted ${q}.` : `DSG Quotes: we received your request ${q}. A rep will send pricing soon.`;
      break;
    case "quote_ready":
      body = `DSG Quotes: ${q}${c.version > 1 ? ` v${c.version}` : ""} is ready${total ? ` (${total})` : ""}.`;
      break;
    case "new_message": {
      const msgs = c.messages ?? [];
      const last = msgs[msgs.length - 1];
      body =
        msgs.length > 1
          ? `DSG Quotes: ${msgs.length} new messages on ${q}.`
          : `DSG Quotes: ${last ? `${clip(last.author, 20)}: ${clip(last.body.replace(/\s+/g, " "), 70)}` : `new message on ${q}`}`;
      break;
    }
    case "changes_requested":
      body = `DSG Quotes: ${clip(c.customerName || "Customer", 24)} requested changes on ${q}.`;
      break;
    case "accepted":
      body = forSales ? `DSG Quotes: ${q} was accepted${total ? ` (${total})` : ""}.` : `DSG Quotes: you accepted ${q}. Buy now to lock in prices.`;
      break;
    case "ordered":
      body = forSales ? `DSG Quotes: order placed from ${q}.` : `DSG Quotes: your order from ${q} is confirmed.`;
      break;
    case "floor_approval":
      body = `DSG Quotes: ${clip(c.floor?.requester ?? "A rep", 20)} requests floor approval on ${q}.`;
      break;
    case "expiring":
      body = c.expired ? `DSG Quotes: ${q} has expired.` : `DSG Quotes: ${q} expires${exp ? ` ${exp}` : " in 3 days"}.`;
      break;
  }
  return `${body} ${c.link}`;
}
