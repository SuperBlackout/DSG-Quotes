import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
// Shared with the worker (which signs the Reply-To addresses and sends the alerts). Dependency-free modules, imported by path
// because apps/api does not depend on the worker package.
import { optOutPhone, recordInboundMessage } from "../../../worker/src/inbound";
import { extractEmail, parseReplyAddress } from "../../../worker/src/lib/reply-token";
import { normalizePhone, smsKeyword } from "../../../worker/src/lib/phone";
import { htmlToText, stripQuotedReply } from "../../../worker/src/lib/strip-quoted";
import { verifyTwilioSignature } from "../../../worker/src/lib/twilio-signature";
import "../context";
import { ApiError } from "../errors";

/**
 * Inbound provider webhooks (docs/openapi.yaml `hookEmailInbound`, `hookTwilioInbound`).
 *
 *   POST /hooks/email-inbound   Postmark inbound JSON, HTTP basic auth where the password is POSTMARK_INBOUND_TOKEN.
 *   POST /hooks/twilio-inbound  Twilio form post, X-Twilio-Signature (HMAC-SHA1 of URL + params with TWILIO_AUTH_TOKEN).
 *
 * Each route exists only when its credential is configured (fail closed: no secret, no route). See `hooksEnabled`.
 */
export interface HookOptions {
  postmarkInboundToken?: string | null;
  twilioAuthToken?: string | null;
  /** Exact public URL Twilio calls, if the request URL as seen by this process differs (proxy rewrites). */
  twilioWebhookUrl?: string | null;
  /** HMAC secret for Reply-To tokens; must equal the worker's REPLY_TOKEN_SECRET (defaults to SHOPIFY_API_SECRET). */
  replySecret: string;
  replyDomain: string;
  supportEmail?: string;
  supportPhone?: string | null;
}

export const hooksEnabled = (env: NodeJS.ProcessEnv = process.env) => Boolean(env.POSTMARK_INBOUND_TOKEN || env.TWILIO_AUTH_TOKEN);

export function hookOptionsFromEnv(apiSecret: string, env: NodeJS.ProcessEnv = process.env): HookOptions {
  return {
    postmarkInboundToken: env.POSTMARK_INBOUND_TOKEN || null,
    twilioAuthToken: env.TWILIO_AUTH_TOKEN || null,
    twilioWebhookUrl: env.TWILIO_WEBHOOK_URL || null,
    replySecret: env.REPLY_TOKEN_SECRET || apiSecret,
    replyDomain: env.EMAIL_REPLY_DOMAIN || "reply.dsg.direct",
    supportEmail: env.SUPPORT_EMAIL || env.EMAIL_FROM || "quotes@dsg.direct",
    supportPhone: env.SUPPORT_PHONE || null,
  };
}

const sha = (s: string) => createHash("sha256").update(s).digest();
const safeEq = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));

function basicAuthOk(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const i = decoded.indexOf(":");
  const user = i < 0 ? decoded : decoded.slice(0, i);
  const pass = i < 0 ? "" : decoded.slice(i + 1);
  // Postmark lets you put the secret in either half of https://user:pass@host/...
  return safeEq(pass, token) || safeEq(user, token);
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown) => (typeof v === "string" ? v : "");
const MAX_BODY = 10_000;

const isAutoReply = (headers: unknown): boolean => {
  const list = Array.isArray(headers) ? headers.map(rec) : [];
  return list.some((h) => {
    const name = str(h.Name).toLowerCase();
    const value = str(h.Value).toLowerCase();
    return (name === "auto-submitted" && value !== "no") || name === "x-autoreply" || name === "x-autorespond" || (name === "precedence" && /bulk|junk|auto_reply|list/.test(value));
  });
};

export async function hookRoutes(app: FastifyInstance, opts: HookOptions) {
  const deps = app.deps;
  const shop = deps.config.shopDomain;

  // ------------------------------------------------------------------------------------------------ email
  if (opts.postmarkInboundToken) {
    const token = opts.postmarkInboundToken;
    app.post("/email-inbound", async (req) => {
      if (!basicAuthOk(req.headers.authorization, token)) throw new ApiError("UNAUTHENTICATED", "Invalid inbound credentials");
      const b = rec(req.body);

      // Which quote and which side? From the Reply-To address we issued: q-<quoteId>-<token>@<reply domain>.
      const candidates = [
        str(b.OriginalRecipient),
        ...(Array.isArray(b.ToFull) ? b.ToFull.map((t) => str(rec(t).Email)) : []),
        ...str(b.To).split(","),
      ];
      let target: { quoteId: string; role: "c" | "s" } | null = null;
      for (const c of candidates) {
        target = parseReplyAddress(c, opts.replySecret, opts.replyDomain);
        if (target) break;
      }
      if (!target) return { ok: true, result: "no_valid_reply_address" };
      if (isAutoReply(b.Headers)) return { ok: true, result: "auto_reply_ignored" };

      const fromEmail = extractEmail(str(rec(b.FromFull).Email) || str(b.From));
      const ours = stripQuotedReply(str(b.TextBody) || htmlToText(str(b.HtmlBody)));
      const theirs = stripQuotedReply(str(b.StrippedTextReply));
      const text = (theirs && (!ours || theirs.length < ours.length) ? theirs : ours).slice(0, MAX_BODY);
      const attachmentCount = Array.isArray(b.Attachments) ? b.Attachments.length : 0;
      if (!text && !attachmentCount) return { ok: true, result: "empty_reply" };
      const body = attachmentCount ? `${text}${text ? "\n\n" : ""}(${attachmentCount} email attachment${attachmentCount === 1 ? "" : "s"} not imported; upload files in My Quotes.)` : text;
      const messageId = str(b.MessageID);

      const result = await deps.prisma.$transaction(async (tx) => {
        const quote = await tx.quote.findFirst({ where: { id: target!.quoteId, shop } });
        if (!quote) return "unknown_quote";
        if (messageId) {
          if (await tx.webhookReceipt.findUnique({ where: { id: `email:${messageId}` } })) return "duplicate";
          await tx.webhookReceipt.create({ data: { id: `email:${messageId}`, topic: "email-inbound" } });
        }
        if (!fromEmail) return "no_sender";

        if (target!.role === "c") {
          const profile = await tx.customerProfile.findUnique({ where: { shop_customerId: { shop, customerId: quote.customerId } } });
          const allowed = new Set(
            [quote.customerEmail, profile?.email, ...asList(quote.watchers), ...asList(profile?.watchers)].map((e) => extractEmail(e as string | null)).filter((e): e is string => !!e),
          );
          if (!allowed.has(fromEmail)) return "sender_not_on_quote";
          const isOwner = fromEmail === extractEmail(profile?.email) || fromEmail === extractEmail(quote.customerEmail);
          await recordInboundMessage(tx, {
            quoteId: quote.id,
            authorType: "CUSTOMER",
            authorId: quote.customerId,
            authorName: isOwner ? quote.customerName : fromEmail,
            body,
            channel: "EMAIL",
            now: deps.now(),
          });
          return "posted";
        }
        const staff = await tx.staff.findFirst({ where: { shop, email: { equals: fromEmail, mode: "insensitive" } } });
        if (!staff) return "sender_not_staff";
        await recordInboundMessage(tx, { quoteId: quote.id, authorType: "STAFF", authorId: staff.id, authorName: staff.name, body, channel: "EMAIL", now: deps.now() });
        return "posted";
      });
      if (result !== "posted") req.log.warn({ result }, "inbound email not posted");
      // Always 200: a non-2xx makes Postmark retry for hours, and none of these outcomes get better with a retry.
      return { ok: true, result };
    });
  }

  // ------------------------------------------------------------------------------------------------ sms
  if (opts.twilioAuthToken) {
    const authToken = opts.twilioAuthToken;
    app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });

    const twiml = (message?: string) => `<?xml version="1.0" encoding="UTF-8"?><Response>${message ? `<Message>${xml(message)}</Message>` : ""}</Response>`;

    app.post("/twilio-inbound", async (req, reply) => {
      const params = rec(req.body) as Record<string, string>;
      const url = opts.twilioWebhookUrl ?? publicUrl(req);
      if (!verifyTwilioSignature(authToken, url, params, req.headers["x-twilio-signature"] as string | undefined)) {
        throw new ApiError("UNAUTHENTICATED", "Invalid Twilio signature");
      }
      reply.type("text/xml");
      const from = normalizePhone(params.From);
      const text = str(params.Body);
      const sid = str(params.MessageSid);
      if (!from) return twiml();

      const keyword = smsKeyword(text);
      if (keyword === "HELP") {
        return twiml(`DSG Quotes: quote alerts from DSG Distributors. Reply STOP to opt out. Msg&data rates may apply. Help: ${opts.supportPhone ?? opts.supportEmail ?? "quotes@dsg.direct"}`);
      }

      const out = await deps.prisma.$transaction(async (tx) => {
        if (sid) {
          if (await tx.webhookReceipt.findUnique({ where: { id: `sms:${sid}` } })) return { kind: "duplicate" as const };
          await tx.webhookReceipt.create({ data: { id: `sms:${sid}`, topic: "twilio-inbound" } });
        }
        // The last alert we texted to this number tells us which quote (and which person) a reply belongs to.
        const last = await tx.event.findFirst({
          where: {
            type: "NOTIFICATION",
            quote: { shop },
            AND: [{ payload: { path: ["channel"], equals: "sms" } }, { payload: { path: ["to"], equals: from } }, { payload: { path: ["status"], equals: "SENT" } }],
          },
          orderBy: { createdAt: "desc" },
        });
        const ctx = last ? rec(last.payload) : null;

        if (keyword === "STOP") {
          const n = await optOutPhone(tx, shop, from);
          if (last) {
            // Built outside the `data:` literal: this `status` is a send-log field, not Quote.status (integrity grep).
            const payload = { channel: "sms", to: from, status: "OPTED_OUT", keyword: "STOP", recipientKind: ctx?.recipientKind ?? null, recipientKey: ctx?.recipientKey ?? null, rows: n };
            await tx.event.create({ data: { quoteId: last.quoteId, type: "NOTIFICATION", actorType: "SYSTEM", payload, notifiedAt: deps.now(), createdAt: deps.now() } });
          }
          return { kind: "stop" as const };
        }
        if (keyword === "START") return { kind: "start" as const };
        if (!last || !ctx) return { kind: "no_context" as const };

        const quote = await tx.quote.findFirst({ where: { id: last.quoteId, shop } });
        const body = text.trim().slice(0, 1600);
        if (!quote || !body) return { kind: "no_context" as const };
        // Re-check consent: never accept SMS conversation from a number that has since opted out.
        if (ctx.recipientKind === "staff") {
          const staff = await tx.staff.findFirst({ where: { id: str(ctx.recipientKey), shop } });
          if (!staff) return { kind: "no_context" as const };
          await recordInboundMessage(tx, { quoteId: quote.id, authorType: "STAFF", authorId: staff.id, authorName: staff.name, body, channel: "SMS", now: deps.now() });
        } else {
          const consent = await tx.notificationPref.count({ where: { shop, customerId: quote.customerId, phone: from, smsOptInAt: { not: null } } });
          if (consent === 0) return { kind: "no_context" as const };
          await recordInboundMessage(tx, { quoteId: quote.id, authorType: "CUSTOMER", authorId: quote.customerId, authorName: quote.customerName, body, channel: "SMS", now: deps.now() });
        }
        return { kind: "posted" as const };
      });

      if (out.kind === "stop") return twiml(); // Twilio's Advanced Opt-Out sends the carrier-required confirmation itself
      if (out.kind === "start") return twiml("DSG Quotes: to turn text alerts back on, open My Quotes > Notification settings and confirm your number.");
      if (out.kind === "no_context") return twiml("DSG Quotes: we could not match your text to a quote. Please reply from My Quotes on dsg.direct.");
      return twiml();
    });
  }
}

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const publicUrl = (req: FastifyRequest) => `${req.protocol}://${req.hostname}${req.url}`;
