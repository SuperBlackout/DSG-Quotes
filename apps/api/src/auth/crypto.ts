import { createHmac, timingSafeEqual } from "node:crypto";

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

// ---------------------------------------------------------------- app proxy

/**
 * Shopify app proxy signature: remove `signature`, render every other param as `key=value` (repeated keys
 * joined with ","), sort, concatenate with NO separator, HMAC-SHA256 hex with the app secret.
 */
export function computeAppProxySignature(params: URLSearchParams, secret: string): string {
  const grouped = new Map<string, string[]>();
  for (const [k, v] of params) {
    if (k === "signature") continue;
    grouped.set(k, [...(grouped.get(k) ?? []), v]);
  }
  const message = [...grouped.entries()]
    .map(([k, vs]) => `${k}=${vs.join(",")}`)
    .sort()
    .join("");
  return createHmac("sha256", secret).update(message).digest("hex");
}

export type ProxyVerdict = { ok: true; params: URLSearchParams } | { ok: false; reason: string };

export function verifyAppProxyRequest(
  rawQuery: string,
  secret: string,
  opts: { now?: Date; maxAgeSeconds?: number } = {},
): ProxyVerdict {
  const params = new URLSearchParams(rawQuery);
  const sig = params.get("signature");
  if (!sig) return { ok: false, reason: "missing signature" };
  if (!safeEqual(computeAppProxySignature(params, secret), sig)) return { ok: false, reason: "bad signature" };
  const ts = Number(params.get("timestamp"));
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (!Number.isFinite(ts) || ts <= 0) return { ok: false, reason: "missing timestamp" };
  if (Math.abs(now - ts) > (opts.maxAgeSeconds ?? 300)) return { ok: false, reason: "stale timestamp" };
  return { ok: true, params };
}

/** Test/dev helper: append a valid signature + timestamp to a query. */
export function signAppProxyQuery(query: Record<string, string>, secret: string, now = new Date()): string {
  const params = new URLSearchParams({ timestamp: String(Math.floor(now.getTime() / 1000)), ...query });
  params.set("signature", computeAppProxySignature(params, secret));
  return params.toString();
}

// ---------------------------------------------------------------- webhooks

export function verifyShopifyWebhook(rawBody: Buffer | string, hmacHeader: string | undefined, secret: string): boolean {
  if (!hmacHeader) return false;
  const digest = createHmac("sha256", secret).update(rawBody).digest("base64");
  return safeEqual(digest, hmacHeader);
}

export function signShopifyWebhook(rawBody: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}

// ---------------------------------------------------------------- session tokens (JWT HS256)

export interface SessionClaims {
  /** Present on admin session tokens, absent on customer-account tokens. */
  iss?: string;
  dest: string;
  aud: string;
  sub: string;
  exp: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  sid?: string;
}

export type TokenVerdict = { ok: true; claims: SessionClaims } | { ok: false; reason: string };

export interface VerifyTokenOptions {
  secret: string;
  /** Expected `aud` (the app's client id). */
  audience: string;
  /** Expected shop domain; `dest` must be https://<shopDomain>. */
  shopDomain: string;
  now?: Date;
  leewaySeconds?: number;
}

export function verifySessionToken(token: string, opts: VerifyTokenOptions): TokenVerdict {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string; typ?: string };
  let claims: Partial<SessionClaims>;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed token" };
  }
  if (header.alg !== "HS256") return { ok: false, reason: "unsupported alg" };
  const expected = createHmac("sha256", opts.secret).update(`${h}.${p}`).digest("base64url");
  if (!safeEqual(expected, s)) return { ok: false, reason: "bad signature" };

  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const leeway = opts.leewaySeconds ?? 10;
  if (typeof claims.exp !== "number" || now > claims.exp + leeway) return { ok: false, reason: "token expired" };
  if (claims.nbf !== undefined && now < claims.nbf - leeway) return { ok: false, reason: "token not yet valid" };
  if (claims.aud !== opts.audience) return { ok: false, reason: "wrong audience" };
  // Admin tokens carry dest "https://<shop>"; customer-account tokens carry the bare "<shop>" and have no `iss`.
  const dest = typeof claims.dest === "string" ? claims.dest.replace(/^https:\/\//i, "").replace(/\/+$/, "").toLowerCase() : null;
  if (dest !== opts.shopDomain.toLowerCase()) return { ok: false, reason: "wrong shop" };
  if (typeof claims.sub !== "string" || !claims.sub) return { ok: false, reason: "missing subject" };
  return { ok: true, claims: claims as SessionClaims };
}

/** Test/dev helper: mint a token shaped like Shopify's. */
export function signSessionToken(claims: SessionClaims, secret: string): string {
  const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64url(JSON.stringify(claims));
  const s = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}
