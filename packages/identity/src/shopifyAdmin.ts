import { HttpError } from '@dsg/contracts';

export interface ShopifyAdmin {
  graphql<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T>;
}

export const SHOPIFY_ADMIN_API_VERSION = '2026-07';

export interface FetchShopifyAdminOpts {
  shopDomain: string;        // e.g. dsg-xxxx.myshopify.com
  /** Dev Dashboard app credentials: used with the client credentials grant to get 24h Admin tokens (refreshed automatically). */
  clientId?: string;
  clientSecret?: string;
  /** Optional static token (only for legacy admin-created custom apps; new ones can no longer be created). */
  accessToken?: string;
  /** Optional token source (e.g. the offline session the app already stores). Takes priority over the client credentials grant. */
  tokenProvider?: () => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/** Real Admin GraphQL client. Any transport/GraphQL failure surfaces as HttpError(503) without detail. */
export class FetchShopifyAdmin implements ShopifyAdmin {
  #token?: { value: string; expiresAt: number };
  #inflight?: Promise<string>;
  constructor(private o: FetchShopifyAdminOpts) {
    if (!o.accessToken && !o.tokenProvider && !(o.clientId && o.clientSecret)) throw new Error('FetchShopifyAdmin needs clientId+clientSecret, tokenProvider or accessToken');
  }
  static fromEnv(env: NodeJS.ProcessEnv = process.env): FetchShopifyAdmin {
    const shopDomain = env.SHOPIFY_SHOP_DOMAIN;
    if (!shopDomain) throw new Error('SHOPIFY_SHOP_DOMAIN required');
    const clientId = env.SHOPIFY_API_KEY, clientSecret = env.SHOPIFY_API_SECRET, accessToken = env.SHOPIFY_ADMIN_ACCESS_TOKEN;
    if (!accessToken && !(clientId && clientSecret)) throw new Error('SHOPIFY_API_KEY and SHOPIFY_API_SECRET required');
    return new FetchShopifyAdmin({ shopDomain, clientId, clientSecret, accessToken });
  }

  async #getToken(force = false): Promise<string> {
    if (this.o.accessToken) return this.o.accessToken;
    if (this.o.tokenProvider) return this.o.tokenProvider();
    const now = (this.o.now ?? Date.now)();
    if (!force && this.#token && this.#token.expiresAt - 60_000 > now) return this.#token.value;
    this.#inflight ??= (async () => {
      const f = this.o.fetchImpl ?? fetch;
      const res = await f(`https://${this.o.shopDomain}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.o.clientId!, client_secret: this.o.clientSecret! }),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 8000),
      });
      if (!res.ok) throw new Error(`token status ${res.status}`);
      const j = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!j.access_token) throw new Error('no token');
      this.#token = { value: j.access_token, expiresAt: now + (j.expires_in ?? 86399) * 1000 };
      return j.access_token;
    })().finally(() => { this.#inflight = undefined; });
    return this.#inflight;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const f = this.o.fetchImpl ?? fetch;
    const call = async (token: string) => f(`https://${this.o.shopDomain}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 8000),
    });
    try {
      let res = await call(await this.#getToken());
      if (res.status === 401 && !this.o.accessToken && !this.o.tokenProvider) res = await call(await this.#getToken(true));
      if (!res.ok) throw new Error(`status ${res.status}`);
      const body = (await res.json()) as { data?: T; errors?: unknown };
      if (body.errors || body.data === undefined) throw new Error('graphql errors');
      return body.data;
    } catch {
      throw new HttpError(503, 'Account lookup temporarily unavailable');
    }
  }
}
