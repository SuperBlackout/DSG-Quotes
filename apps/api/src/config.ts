/** Runtime configuration. Everything comes from env; tests construct a Config directly with fake secrets. */
export interface Config {
  nodeEnv: string;
  port: number;
  host: string;
  /** myshopify domain of the (single) shop this deployment serves, e.g. dsg-dev.myshopify.com */
  shopDomain: string;
  /** Shopify app Client ID (JWT `aud`). */
  apiKey: string;
  /** Shopify app Client secret: signs session tokens, app proxy requests and webhooks. */
  apiSecret: string;
  /** Public customer-facing base URL (storefront app proxy). */
  appPublicUrl: string;
  /** Default quote validity when a rep does not pick an expiry. */
  defaultExpiryDays: number;
  /** Max allowed clock skew / age for signed requests, in seconds. */
  signatureMaxAgeSeconds: number;
  attachments: {
    bucket: string;
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    publicBaseUrl: string;
  } | null;
}

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required env var ${key}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const bucket = env.ATTACHMENTS_BUCKET;
  const endpoint = env.ATTACHMENTS_S3_ENDPOINT;
  return {
    nodeEnv: env.NODE_ENV ?? "development",
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? "0.0.0.0",
    shopDomain: req(env, "SHOP_DOMAIN"),
    apiKey: req(env, "SHOPIFY_API_KEY"),
    apiSecret: req(env, "SHOPIFY_API_SECRET"),
    appPublicUrl: env.APP_PUBLIC_URL ?? "",
    defaultExpiryDays: Number(env.QUOTE_DEFAULT_EXPIRY_DAYS ?? 14),
    signatureMaxAgeSeconds: Number(env.SIGNATURE_MAX_AGE_SECONDS ?? 300),
    attachments:
      bucket && endpoint
        ? {
            bucket,
            endpoint,
            region: env.ATTACHMENTS_REGION ?? "us-east-1",
            accessKeyId: req(env, "ATTACHMENTS_ACCESS_KEY_ID"),
            secretAccessKey: req(env, "ATTACHMENTS_SECRET_ACCESS_KEY"),
            publicBaseUrl: env.ATTACHMENTS_PUBLIC_BASE_URL ?? `${endpoint.replace(/\/$/, "")}/${bucket}`,
          }
        : null,
  };
}
