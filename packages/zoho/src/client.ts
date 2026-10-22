import {
  ZohoContact, ZohoInvoice, ZohoPayment, ZohoCreditNote, ZohoSalesOrder,
  type ZohoReader,
} from '@dsg/contracts';
import type { ZodTypeDef, ZodType as ZodTypeBase } from 'zod';
/** Accept schemas with defaults (input differs from output). */
type ZodType<T> = ZodTypeBase<T, ZodTypeDef, unknown>;
import { loadZohoConfigFromEnv, type ZohoConfig } from './config.js';
import {
  ZohoApiError, ZohoAuthError, ZohoError, ZohoNetworkError, ZohoNotFoundError,
  ZohoRateLimitError, ZohoReadOnlyViolation, ZohoSchemaError, ZohoServerError,
} from './errors.js';
import { RateLimiter } from './limiter.js';

export interface ZohoClientOptions {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxRetries?: number; // retries after the first attempt (default 4)
  baseDelayMs?: number; // default 500
  maxDelayMs?: number; // default 60_000
  maxPerMinute?: number; // default 60
  maxConcurrent?: number; // default 6
  perPage?: number; // default 200 (Zoho max)
  maxPages?: number; // safety cap, default 500
}

const REFRESH_MARGIN_MS = 5 * 60_000;

type Params = Record<string, string | number | undefined>;
type Json = Record<string, any>;

/** Recursively drop null / "" values so optional contract fields validate. */
function clean(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === null || val === '') continue;
      out[k] = clean(val);
    }
    return out;
  }
  return v;
}

/** Hard read-only guard: only GET is ever allowed against the Books API. */
export function assertReadOnlyMethod(method: string, path = ''): void {
  if (method.toUpperCase() !== 'GET') {
    throw new ZohoReadOnlyViolation(`Zoho client is read-only; refusing ${method} ${path}`);
  }
}

export class ZohoClient implements ZohoReader {
  readonly #cfg: ZohoConfig;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #limiter: RateLimiter;
  readonly #o: Required<Pick<ZohoClientOptions, 'maxRetries' | 'baseDelayMs' | 'maxDelayMs' | 'perPage' | 'maxPages'>>;
  #token: { value: string; expiresAt: number } | null = null;
  #refreshing: Promise<string> | null = null;

  constructor(config: ZohoConfig = loadZohoConfigFromEnv(), opts: ZohoClientOptions = {}) {
    this.#cfg = { ...config };
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = opts.now ?? Date.now;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#random = opts.random ?? Math.random;
    this.#limiter = new RateLimiter({
      maxPerMinute: opts.maxPerMinute ?? 60,
      maxConcurrent: opts.maxConcurrent ?? 6,
      now: this.#now,
      sleep: this.#sleep,
    });
    this.#o = {
      maxRetries: opts.maxRetries ?? 4,
      baseDelayMs: opts.baseDelayMs ?? 500,
      maxDelayMs: opts.maxDelayMs ?? 60_000,
      perPage: opts.perPage ?? 200,
      maxPages: opts.maxPages ?? 500,
    };
  }

  /** Keep secrets out of `console.log(client)` / JSON.stringify. */
  toJSON() { return { name: 'ZohoClient' }; }

  // ---------- redaction ----------
  #redact(s: string): string {
    let out = s;
    const secrets = [this.#cfg.clientSecret, this.#cfg.refreshToken, this.#cfg.clientId, this.#token?.value];
    for (const sec of secrets) if (sec && sec.length >= 4) out = out.split(sec).join('[REDACTED]');
    return out;
  }

  // ---------- OAuth ----------
  async #getToken(staleToken?: string): Promise<string> {
    const t = this.#token;
    if (t && t.value !== staleToken && this.#now() < t.expiresAt - REFRESH_MARGIN_MS) return t.value;
    // single flight
    this.#refreshing ??= this.#refresh().finally(() => { this.#refreshing = null; });
    return this.#refreshing;
  }

  async #refresh(): Promise<string> {
    const body = new URLSearchParams({
      refresh_token: this.#cfg.refreshToken,
      client_id: this.#cfg.clientId,
      client_secret: this.#cfg.clientSecret,
      grant_type: 'refresh_token',
    });
    const url = `${this.#cfg.accountsBase.replace(/\/+$/, '')}/oauth/v2/token`;
    let res: Response;
    try {
      // The ONLY non-GET request this client ever makes.
      res = await this.#fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (e) {
      throw new ZohoNetworkError(this.#redact(`OAuth token request failed: ${(e as Error).message}`));
    }
    let json: Json = {};
    try { json = (await res.json()) as Json; } catch { /* handled below */ }
    // Zoho reports OAuth failures with HTTP 200 and {"error": "..."}.
    if (!res.ok || json.error || typeof json.access_token !== 'string') {
      throw new ZohoAuthError(
        this.#redact(`OAuth token refresh failed (HTTP ${res.status}): ${String(json.error ?? 'no access_token in response')}`),
        res.status,
      );
    }
    const ttlSec = Number(json.expires_in_sec ?? json.expires_in ?? 3600);
    // Zoho sometimes reports expires_in in ms (3600000)
    const ttlMs = ttlSec > 100_000 ? ttlSec : ttlSec * 1000;
    this.#token = { value: json.access_token, expiresAt: this.#now() + ttlMs };
    return json.access_token;
  }

  // ---------- HTTP core ----------
  #url(path: string, params: Params): string {
    const u = new URL(this.#cfg.apiBase.replace(/\/+$/, '') + path);
    u.searchParams.set('organization_id', this.#cfg.orgId);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
    return u.toString();
  }

  #retryDelay(attempt: number, retryAfter: string | null): number {
    let d = Math.min(this.#o.maxDelayMs, this.#o.baseDelayMs * 2 ** attempt * (1 + this.#random() * 0.5));
    if (retryAfter) {
      const secs = Number(retryAfter);
      const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(retryAfter) - this.#now();
      if (Number.isFinite(ms) && ms > 0) d = Math.min(this.#o.maxDelayMs, Math.max(d, ms));
    }
    return d;
  }

  async #errorFromResponse(res: Response): Promise<ZohoError> {
    let text = '';
    try { text = await res.text(); } catch { /* ignore */ }
    let json: Json | null = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    const code = typeof json?.code === 'number' ? json.code : undefined;
    const msg = this.#redact(String(json?.message ?? text.slice(0, 200) ?? '')).slice(0, 300);
    const label = `Zoho HTTP ${res.status}${code !== undefined ? ` code ${code}` : ''}: ${msg}`;
    if (res.status === 401 || res.status === 403) return new ZohoAuthError(label, res.status, code);
    if (res.status === 404 || code === 1002) return new ZohoNotFoundError(label, res.status, code);
    if (res.status === 429) return new ZohoRateLimitError(label, res.status, code);
    if (res.status >= 500) return new ZohoServerError(label, res.status, code);
    return new ZohoApiError(label, res.status, code);
  }

  /** Performs a rate-limited, retried GET and returns a 2xx Response. */
  async #get(path: string, params: Params = {}): Promise<Response> {
    return this.#send('GET', path, params);
  }

  async #send(method: string, path: string, params: Params): Promise<Response> {
    assertReadOnlyMethod(method, path);
    const url = this.#url(path, params);
    let usedToken: string | undefined;
    let authRetried = false;
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      let netErr: unknown;
      const token = await this.#getToken(authRetried ? usedToken : undefined);
      usedToken = token;
      const release = await this.#limiter.acquire();
      try {
        res = await this.#fetch(url, {
          method: 'GET',
          headers: { authorization: `Zoho-oauthtoken ${token}`, accept: 'application/json' },
        });
      } catch (e) {
        netErr = e;
      } finally {
        release();
      }

      if (res && res.ok) return res;

      if (res && res.status === 401 && !authRetried) {
        authRetried = true;
        await res.text().catch(() => undefined);
        attempt--; // does not consume a retry
        continue;
      }

      const retriable = netErr !== undefined || (res !== undefined && (res.status === 429 || res.status >= 500));
      if (!retriable) throw await this.#errorFromResponse(res!);
      if (attempt >= this.#o.maxRetries) {
        if (netErr !== undefined) throw new ZohoNetworkError(this.#redact(`Zoho request failed: ${(netErr as Error).message}`));
        throw await this.#errorFromResponse(res!);
      }
      const retryAfter = res?.headers.get('retry-after') ?? null;
      if (res) await res.text().catch(() => undefined);
      await this.#sleep(this.#retryDelay(attempt, retryAfter));
    }
  }

  async #json(path: string, params: Params = {}): Promise<Json> {
    const res = await this.#get(path, params);
    let json: Json;
    try { json = (await res.json()) as Json; } catch {
      throw new ZohoApiError('Zoho returned a non-JSON response', res.status);
    }
    if (typeof json.code === 'number' && json.code !== 0) {
      const msg = this.#redact(String(json.message ?? 'unknown error')).slice(0, 300);
      const text = `Zoho error code ${json.code}: ${msg}`;
      if (json.code === 1002) throw new ZohoNotFoundError(text, res.status, json.code);
      if (json.code === 57 || json.code === 14) throw new ZohoAuthError(text, res.status, json.code);
      throw new ZohoApiError(text, res.status, json.code);
    }
    return json;
  }

  #parse<T>(schema: ZodType<T>, raw: unknown, what: string): T {
    const r = schema.safeParse(clean(raw));
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
      throw new ZohoSchemaError(`Unexpected Zoho ${what} shape at: ${paths}`);
    }
    return r.data;
  }

  async #listAll<T>(path: string, key: string, schema: ZodType<T>, params: Params): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= this.#o.maxPages; page++) {
      const json = await this.#json(path, { ...params, page, per_page: this.#o.perPage });
      const rows = json[key];
      if (!Array.isArray(rows)) throw new ZohoSchemaError(`Zoho response missing "${key}" array`);
      for (const r of rows) out.push(this.#parse(schema, r, key));
      if (!json.page_context?.has_more_page) return out;
    }
    throw new ZohoError(`Zoho pagination exceeded ${this.#o.maxPages} pages for ${path}`);
  }

  /** Zoho `last_modified_time` wants ISO with offset; accept plain dates. */
  static #sinceParam(since?: string): string | undefined {
    if (!since) return undefined;
    return /T/.test(since) ? since : `${since}T00:00:00+0000`;
  }

  // ---------- contacts ----------
  #numberOf(raw: Json): string | undefined {
    const f = this.#cfg.customerNumberField;
    const direct = raw[f] ?? raw.customer_number;
    if (direct !== undefined && direct !== null && direct !== '') return String(direct);
    const hash = raw.custom_field_hash;
    if (hash && typeof hash === 'object') {
      const v = (hash as Json)[f];
      if (v !== undefined && v !== null && v !== '') return String(v);
    }
    if (Array.isArray(raw.custom_fields)) {
      const cf = raw.custom_fields.find((c: Json) => c.api_name === f || c.label === f || c.customfield_id === f);
      if (cf && cf.value !== undefined && cf.value !== null && cf.value !== '') return String(cf.value);
    }
    return undefined;
  }

  async getContact(id: string): Promise<ZohoContact> {
    const json = await this.#json(`/contacts/${encodeURIComponent(id)}`);
    const c = json.contact as Json | undefined;
    if (!c) throw new ZohoSchemaError('Zoho response missing "contact"');
    return this.#toContact(c);
  }

  #toContact(c: Json): ZohoContact {
    const num = this.#numberOf(c);
    const credit = c.credit_limit === '' || c.credit_limit == null ? undefined : Number(c.credit_limit);
    return this.#parse(ZohoContact, { ...c, customer_number: num, credit_limit: credit, payment_terms_label: c.payment_terms_label }, 'contact');
  }

  async findContactByCustomerNumber(n: string): Promise<ZohoContact | null> {
    const wanted = n.trim();
    if (!wanted) return null;
    // LIVE-VERIFIED (2026-10-20): Zoho's search_text does NOT filter by customer number (it returned the first 200 customers
    // for any value). So we page through the customer list, whose rows carry contact_number, and enforce an exact match ourselves.
    // List items may not carry custom fields, so candidates with no number info are verified via the detail endpoint (capped).
    let detailBudget = 10;
    for (let page = 1; page <= this.#o.maxPages; page++) {
      const json = await this.#json('/contacts', {
        contact_type: 'customer', page, per_page: this.#o.perPage,
      });
      const rows = (json.contacts ?? []) as Json[];
      for (const row of rows) {
        const listed = this.#numberOf(row);
        if (listed !== undefined) {
          if (listed.trim() === wanted) return this.getContact(String(row.contact_id));
        } else if (detailBudget > 0) {
          detailBudget--;
          const full = await this.getContact(String(row.contact_id));
          if (full.customer_number.trim() === wanted) return full;
        }
      }
      if (!json.page_context?.has_more_page) return null;
    }
    return null;
  }

  // ---------- documents ----------
  #docParams(customerId: string, since?: string): Params {
    return { customer_id: customerId, last_modified_time: ZohoClient.#sinceParam(since) };
  }
  listInvoices(customerId: string, since?: string) {
    return this.#listAll('/invoices', 'invoices', ZohoInvoice, this.#docParams(customerId, since));
  }
  listPayments(customerId: string, since?: string) {
    return this.#listAll('/customerpayments', 'customerpayments', ZohoPayment, this.#docParams(customerId, since));
  }
  listCreditNotes(customerId: string, since?: string) {
    return this.#listAll('/creditnotes', 'creditnotes', ZohoCreditNote, this.#docParams(customerId, since));
  }
  listSalesOrders(customerId: string, since?: string) {
    return this.#listAll('/salesorders', 'salesorders', ZohoSalesOrder, this.#docParams(customerId, since));
  }

  // ---------- PDFs ----------
  async #pdf(path: string, params: Params): Promise<Uint8Array> {
    const res = await this.#get(path, { ...params, accept: 'pdf' });
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('json')) {
      // Zoho reports some errors as 200 + JSON
      const j = (await res.json().catch(() => ({}))) as Json;
      throw new ZohoApiError(this.#redact(`Zoho code ${j.code}: ${String(j.message ?? 'expected PDF, got JSON')}`).slice(0, 300), res.status, j.code);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  getInvoicePdf(invoiceId: string): Promise<Uint8Array> {
    return this.#pdf(`/invoices/${encodeURIComponent(invoiceId)}`, {});
  }

  /**
   * ISOLATED: the customer-statement PDF endpoint. Best-known path from Zoho Books v3 docs is
   * GET /contacts/{contact_id}/statements?accept=pdf with from_date/to_date.
   * Live-checked 2026-10-20: HTTP 200 application/pdf for both pilot dealers; whether the date range is honoured still needs an eyeball. If Zoho differs (e.g. `/customers/{id}/statements`
   * or `start_date`/`end_date` param names) change only this function.
   */
  getStatementPdf(customerId: string, from: string, to: string): Promise<Uint8Array> {
    return this.#pdf(`/contacts/${encodeURIComponent(customerId)}/statements`, { from_date: from, to_date: to });
  }
}
