import pg from "pg";
import type { BuyerResolver, ZohoReader } from "@dsg/contracts";
import { AccountMapRepo, InMemorySyncQueue, safeMessage, syncCustomer, type SyncQueue } from "@dsg/statement";
import { FetchShopifyAdmin, ShopifyBuyerResolver, type ShopifyAdmin } from "@dsg/identity";
import { ZohoClient, loadZohoConfigFromEnv } from "@dsg/zoho";
import type { Config } from "../config";

/**
 * Everything the account pages (statement + account info) need. Optional on AppDeps: the API runs without it
 * (and the /a routes are simply not mounted) until the Zoho credentials are set, so quotes deploys are unaffected.
 */
export interface StatementDeps {
  pool: pg.Pool;
  resolver: BuyerResolver;
  zoho: ZohoReader;
  /** Shopify Admin GraphQL (company profile for the Account page). */
  admin: ShopifyAdmin;
  queue: Pick<SyncQueue, "enqueueSync">;
  /** Origin used to build /a/files/<token> download URLs, no trailing slash. */
  publicBaseUrl: string;
  /** HMAC secret for POST /webhooks/zoho. Empty: webhooks are rejected (fail closed). */
  webhookSecret?: string | null;
  rateLimit?: { max: number; windowMs: number };
  /** Called on shutdown. */
  close?: () => Promise<void>;
}

const ZOHO_KEYS = ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN", "ZOHO_ORG_ID"] as const;

/** True when every Zoho credential is present. All four or none: a partial set is a configuration error. */
export function statementConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const set = ZOHO_KEYS.filter((k) => env[k]);
  if (set.length === 0) return false;
  if (set.length !== ZOHO_KEYS.length) throw new Error(`Zoho is partly configured; set all of ${ZOHO_KEYS.join(", ")} or none`);
  return true;
}

/**
 * Builds the statement dependencies from env, or returns null when Zoho is not configured.
 * `tokenProvider` is the offline Shopify token the quotes app already stores (no second OAuth grant needed).
 */
export function statementDepsFromEnv(
  config: Config,
  databaseUrl: string,
  tokenProvider: () => Promise<string>,
  env: NodeJS.ProcessEnv = process.env,
  log: (msg: string, meta?: Record<string, unknown>) => void = (msg, meta) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...meta })),
): StatementDeps | null {
  if (!statementConfigured(env)) return null;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: Number(env.STATEMENT_DB_POOL_MAX ?? 5) });
  pool.on("error", (e) => log("statement pool error", { error: safeMessage(e) }));
  const zoho = new ZohoClient(loadZohoConfigFromEnv(env));
  const admin = new FetchShopifyAdmin({ shopDomain: config.shopDomain, tokenProvider });
  const resolver = new ShopifyBuyerResolver({
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    allowedShops: [config.shopDomain],
    admin,
    accountMap: new AccountMapRepo(pool),
  });
  const syncDeps = { pool, zoho, log };
  const queue = new InMemorySyncQueue((id) => syncCustomer(syncDeps, id), {
    debounceMs: Number(env.SYNC_DEBOUNCE_MS ?? "30000"),
    onError: (id, e) => log("sync error", { zohoCustomerId: id, error: safeMessage(e) }),
  });
  const base = (env.STATEMENT_PUBLIC_BASE_URL || env.SHOPIFY_APP_URL || config.appPublicUrl || "").replace(/\/+$/, "");
  if (!base) throw new Error("Set STATEMENT_PUBLIC_BASE_URL (or SHOPIFY_APP_URL): PDF download links need the API's public origin");
  return {
    pool, resolver, zoho, admin, queue,
    publicBaseUrl: base,
    webhookSecret: env.ZOHO_WEBHOOK_SECRET || null,
    close: async () => { await queue.close(); await pool.end(); },
  };
}
