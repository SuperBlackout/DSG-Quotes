import type { PrismaClient } from "@prisma/client";
import { ConsoleEmailProvider, ConsoleSmsProvider } from "./providers/fakes";
import { PostmarkEmailProvider } from "./providers/postmark";
import { TwilioSmsProvider } from "./providers/twilio";
import type { EmailProvider, SmsProvider } from "./providers/types";

export interface NotifyConfig {
  /** myshopify domain: scopes every query (one shop per deployment, like the API). */
  shop: string;
  /** Customer-facing base URL, e.g. https://dsg.direct/apps/quotes. Quote links are `${appPublicUrl}/quotes/<id>`. */
  appPublicUrl: string;
  /** Storefront page that shows a dealer their quote (e.g. https://dsg.direct/pages/quote); links are `<page>?id=<quoteId>`. Falls back to `${appPublicUrl}/quotes/<id>` when unset. */
  customerQuotePageUrl: string;
  /** Base for staff links: `${adminQuoteUrl}/<quoteId>`. */
  adminQuoteUrl: string;
  emailFrom: string;
  replyDomain: string;
  /** HMAC secret for Reply-To tokens. */
  replySecret: string;
  /** Used when a quote has no assigned rep, no team and the shop has no manager. Optional. */
  salesFallbackEmail: string | null;
  supportEmail: string;
  supportPhone: string | null;
  /** Window within which NEW_MESSAGE alerts for one quote are merged into one. */
  bundleWindowMs: number;
  /** Retry policy for transient provider failures. */
  maxAttempts: number;
  retryBackoffMs: number;
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export const consoleLogger: Logger = {
  info: (msg, f) => console.log(JSON.stringify({ level: "info", msg, ...f })),
  warn: (msg, f) => console.warn(JSON.stringify({ level: "warn", msg, ...f })),
  error: (msg, f) => console.error(JSON.stringify({ level: "error", msg, ...f })),
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** Everything the processor and cron need, injected so tests can pass fakes, a fixed clock and a test database. */
export interface WorkerDeps {
  prisma: PrismaClient;
  email: EmailProvider;
  /** null = SMS channel disabled (no Twilio credentials): SMS sends are skipped and logged, never failed. */
  sms: SmsProvider | null;
  config: NotifyConfig;
  now: () => Date;
  log: Logger;
}

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required env var ${key}`);
  return v;
}

export function loadNotifyConfig(env: NodeJS.ProcessEnv = process.env): NotifyConfig {
  const shop = req(env, "SHOP_DOMAIN");
  const from = env.EMAIL_FROM ?? "quotes@dsg.direct";
  return {
    shop,
    appPublicUrl: (env.APP_PUBLIC_URL ?? "").replace(/\/$/, ""),
    customerQuotePageUrl: (env.CUSTOMER_QUOTE_PAGE_URL ?? "").replace(/\/$/, ""),
    adminQuoteUrl: (env.ADMIN_QUOTE_URL ?? `https://${shop}/admin/apps/dsg-quotes/quotes`).replace(/\/$/, ""),
    emailFrom: from,
    replyDomain: env.EMAIL_REPLY_DOMAIN ?? "reply.dsg.direct",
    replySecret: env.REPLY_TOKEN_SECRET ?? req(env, "SHOPIFY_API_SECRET"),
    salesFallbackEmail: env.SALES_NOTIFY_EMAIL || null,
    supportEmail: env.SUPPORT_EMAIL ?? from,
    supportPhone: env.SUPPORT_PHONE || null,
    bundleWindowMs: Number(env.NEW_MESSAGE_BUNDLE_MS ?? 5 * 60_000),
    maxAttempts: Number(env.NOTIFY_MAX_ATTEMPTS ?? 5),
    retryBackoffMs: Number(env.NOTIFY_RETRY_BACKOFF_MS ?? 60_000),
  };
}

/**
 * Email: Postmark when POSTMARK_SERVER_TOKEN is set; outside production a console sink; in production a missing token is fatal
 * (silently dropping every alert would be worse than refusing to start).
 * SMS: Twilio when all three TWILIO_* vars are set, otherwise disabled (the A2P approval may lag the email launch).
 */
export function buildProviders(env: NodeJS.ProcessEnv = process.env, log: Logger = consoleLogger): { email: EmailProvider; sms: SmsProvider | null } {
  let email: EmailProvider;
  if (env.POSTMARK_SERVER_TOKEN) email = new PostmarkEmailProvider(env.POSTMARK_SERVER_TOKEN);
  else if (env.NODE_ENV === "production" && env.EMAIL_LOG_ONLY !== "1") throw new Error("Missing required env var POSTMARK_SERVER_TOKEN (or set EMAIL_LOG_ONLY=1 to print emails instead of sending)");
  else {
    log.warn("POSTMARK_SERVER_TOKEN not set: emails are printed to the log, NOT sent");
    email = new ConsoleEmailProvider();
  }

  let sms: SmsProvider | null = null;
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_MESSAGING_SERVICE_SID) {
    sms = new TwilioSmsProvider({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID });
  } else if (env.NODE_ENV !== "production" && env.DEV_CONSOLE_SMS === "1") {
    sms = new ConsoleSmsProvider();
  } else {
    log.warn("Twilio credentials not set: SMS channel disabled");
  }
  return { email, sms };
}
