import { describe, it, expect, vi } from 'vitest';
import { ZohoClient, RateLimiter, ZohoApiError, ZohoAuthError, ZohoNotFoundError, ZohoRateLimitError, ZohoReadOnlyViolation, assertReadOnlyMethod, ZohoError, loadZohoConfigFromEnv, type ZohoConfig } from './index.js';

const SECRETS = { id: 'CLIENTID-abcdef', secret: 'SECRET-xyz-123456', refresh: 'REFRESH-tok-987654' };
const cfg: ZohoConfig = {
  clientId: SECRETS.id, clientSecret: SECRETS.secret, refreshToken: SECRETS.refresh,
  orgId: '999', apiBase: 'https://api.test/books/v3', accountsBase: 'https://acc.test', customerNumberField: 'contact_number',
};
const json = (b: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

function setup(handler: (url: URL, init: RequestInit, n: number) => Response | Promise<Response>, opts = {}) {
  let clock = 1_000_000;
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const sleeps: number[] = [];
  const fetchMock = vi.fn(async (input: any, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.host === 'acc.test') return json({ access_token: 'ATOKEN' + calls.filter((c) => c.url.host === 'acc.test').length, expires_in: 3600 });
    return handler(url, init, calls.length);
  });
  const client = new ZohoClient(cfg, {
    fetch: fetchMock as any, now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    random: () => 0, ...opts,
  });
  return { client, calls, sleeps, fetchMock, advance: (ms: number) => { clock += ms; } };
}
const api = (calls: any[]) => calls.filter((c) => c.url.host === 'api.test');
const inv = (i: number) => ({ invoice_id: `i${i}`, customer_id: 'c1', invoice_number: `INV-${i}`, date: '2026-01-01', due_date: null, status: 'sent', total: 10.5, balance: 5, currency_code: 'USD', reference_number: '' });

describe('oauth', () => {
  it('refreshes via refresh_token grant with POST body, sends bearer, caches', async () => {
    const { client, calls } = setup(() => json({ code: 0, contact: { contact_id: 'c1', contact_name: 'A', contact_number: 'N1' } }));
    await client.getContact('c1'); await client.getContact('c1');
    const tok = calls.filter((c) => c.url.host === 'acc.test');
    expect(tok).toHaveLength(1);
    expect(tok[0]!.init.method).toBe('POST');
    expect(tok[0]!.url.pathname).toBe('/oauth/v2/token');
    expect(String(tok[0]!.init.body)).toContain('grant_type=refresh_token');
    expect(tok[0]!.url.search).toBe('');
    const a = api(calls)[0]!;
    expect((a.init.headers as any).authorization).toBe('Zoho-oauthtoken ATOKEN1');
    expect(a.url.searchParams.get('organization_id')).toBe('999');
  });
  it('is single-flight under concurrency', async () => {
    const { client, calls } = setup(() => json({ code: 0, contact: { contact_id: 'c1', contact_name: 'A' } }));
    await Promise.all([1, 2, 3, 4].map(() => client.getContact('c1')));
    expect(calls.filter((c) => c.url.host === 'acc.test')).toHaveLength(1);
  });
  it('refreshes ~5 minutes before expiry', async () => {
    const { client, calls, advance } = setup(() => json({ code: 0, contact: { contact_id: 'c1', contact_name: 'A' } }));
    await client.getContact('c1');
    advance(54 * 60_000); await client.getContact('c1');
    expect(calls.filter((c) => c.url.host === 'acc.test')).toHaveLength(1);
    advance(2 * 60_000); await client.getContact('c1');
    expect(calls.filter((c) => c.url.host === 'acc.test')).toHaveLength(2);
  });
  it('refreshes once on 401 then succeeds', async () => {
    let n = 0;
    const { client, calls } = setup(() => (n++ === 0 ? json({ code: 57, message: 'bad token' }, { status: 401 }) : json({ code: 0, contact: { contact_id: 'c1', contact_name: 'A' } })));
    await client.getContact('c1');
    expect(calls.filter((c) => c.url.host === 'acc.test')).toHaveLength(2);
  });
  it('maps OAuth error (HTTP 200 + error) to ZohoAuthError without leaking secrets', async () => {
    const fetchMock = vi.fn(async () => json({ error: `invalid_code ${SECRETS.refresh}` }));
    const client = new ZohoClient(cfg, { fetch: fetchMock as any });
    const e = await client.getContact('x').catch((x) => x);
    expect(e).toBeInstanceOf(ZohoAuthError);
    expect(e.message).not.toContain(SECRETS.refresh);
  });
});

describe('pagination & normalisation', () => {
  it('follows has_more_page and normalises via contract schemas', async () => {
    const { client, calls } = setup((url) => {
      const p = Number(url.searchParams.get('page'));
      return json({ code: 0, invoices: [inv(p * 2), inv(p * 2 + 1)], page_context: { page: p, has_more_page: p < 3 } });
    });
    const out = await client.listInvoices('c1', '2026-01-01');
    expect(out).toHaveLength(6);
    expect(out[0]!.due_date).toBeUndefined();
    expect(out[0]!.reference_number).toBe('');
    const a = api(calls);
    expect(a.map((c) => c.url.searchParams.get('page'))).toEqual(['1', '2', '3']);
    expect(a[0]!.url.searchParams.get('customer_id')).toBe('c1');
    expect(a[0]!.url.searchParams.get('per_page')).toBe('200');
    expect(a[0]!.url.searchParams.get('last_modified_time')).toBe('2026-01-01T00:00:00+0000');
  });
  it('hits the right endpoints for each doc type', async () => {
    const { client, calls } = setup(() => json({ code: 0, customerpayments: [], creditnotes: [], salesorders: [], page_context: { has_more_page: false } }));
    await client.listPayments('c1'); await client.listCreditNotes('c1'); await client.listSalesOrders('c1');
    expect(api(calls).map((c) => c.url.pathname)).toEqual(['/books/v3/customerpayments', '/books/v3/creditnotes', '/books/v3/salesorders']);
  });
});

describe('contacts', () => {
  it('findContactByCustomerNumber enforces exact match', async () => {
    const { client } = setup((url) => {
      if (url.pathname.endsWith('/contacts')) return json({ code: 0, contacts: [{ contact_id: 'a', contact_number: 'C-10' }, { contact_id: 'b', contact_number: 'C-1' }], page_context: { has_more_page: false } });
      return json({ code: 0, contact: { contact_id: url.pathname.split('/').pop(), contact_name: 'B', contact_number: 'C-1', credit_limit: '', outstanding_receivable_amount: 12.3 } });
    });
    const c = await client.findContactByCustomerNumber('C-1');
    expect(c?.contact_id).toBe('b');
    expect(c?.customer_number).toBe('C-1');
    expect(c?.credit_limit).toBeUndefined();
    expect(await client.findContactByCustomerNumber('nope')).toBeNull();
  });
});

describe('retry', () => {
  it('retries 429 honouring Retry-After', async () => {
    let n = 0;
    const { client, sleeps } = setup(() => (n++ < 2 ? new Response('{}', { status: 429, headers: { 'retry-after': '7' } }) : json({ code: 0, invoices: [], page_context: { has_more_page: false } })));
    await client.listInvoices('c1');
    expect(n).toBe(3);
    expect(sleeps.filter((s) => s >= 7000)).toHaveLength(2);
  });
  it('uses exponential backoff on 5xx then gives up with typed error', async () => {
    let n = 0;
    const { client, sleeps } = setup(() => { n++; return new Response('boom', { status: 503 }); }, { maxRetries: 3 });
    await expect(client.getContact('c1')).rejects.toBeInstanceOf(ZohoError);
    expect(n).toBe(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
  });
  it('exhausted 429 -> ZohoRateLimitError', async () => {
    const { client } = setup(() => new Response('{}', { status: 429 }), { maxRetries: 1 });
    await expect(client.getContact('c1')).rejects.toBeInstanceOf(ZohoRateLimitError);
  });
  it('does not retry other 4xx', async () => {
    let n = 0;
    const { client } = setup(() => { n++; return json({ code: 4, message: 'Invalid value' }, { status: 400 }); });
    await expect(client.getContact('c1')).rejects.toBeInstanceOf(ZohoApiError);
    expect(n).toBe(1);
  });
});

describe('rate limiter', () => {
  it('sliding window delays the request past the per-minute budget', async () => {
    let t = 0; const sleeps: number[] = [];
    const rl = new RateLimiter({ maxPerMinute: 5, maxConcurrent: 100, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
    for (let i = 0; i < 5; i++) (await rl.acquire())();
    expect(sleeps).toEqual([]);
    (await rl.acquire())();
    expect(sleeps).toEqual([60000]);
  });
  it('never exceeds 60 requests in any minute through the client', async () => {
    const times: number[] = [];
    let clock = 0;
    const fetchMock = vi.fn(async (input: any) => {
      const u = new URL(String(input));
      if (u.host === 'acc.test') return json({ access_token: 'T', expires_in: 3600000 });
      times.push(clock);
      return json({ code: 0, contact: { contact_id: 'c', contact_name: 'n' } });
    });
    const client = new ZohoClient(cfg, { fetch: fetchMock as any, now: () => clock, sleep: async (ms) => { clock += ms; } });
    for (let i = 0; i < 130; i++) await client.getContact('c');
    for (let i = 0; i < times.length; i++) {
      const inWindow = times.filter((x) => x >= times[i]! && x < times[i]! + 60_000).length;
      expect(inWindow).toBeLessThanOrEqual(60);
    }
    expect(clock).toBeGreaterThan(60_000);
  });
  it('limits concurrency to 6', async () => {
    let cur = 0, peak = 0; const gates: Array<() => void> = [];
    const fetchMock = vi.fn(async (input: any) => {
      const u = new URL(String(input));
      if (u.host === 'acc.test') return json({ access_token: 'T', expires_in: 3600 });
      cur++; peak = Math.max(peak, cur);
      await new Promise<void>((r) => gates.push(r));
      cur--;
      return json({ code: 0, contact: { contact_id: 'c', contact_name: 'n' } });
    });
    const client = new ZohoClient(cfg, { fetch: fetchMock as any });
    const ps = Array.from({ length: 12 }, () => client.getContact('c'));
    for (let i = 0; i < 12; i++) {
      await vi.waitFor(() => expect(gates.length).toBeGreaterThan(0));
      gates.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
    await Promise.all(ps);
    expect(peak).toBe(6);
  });
});

describe('guards & errors', () => {
  it('refuses non-GET requests', () => {
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH', 'post']) expect(() => assertReadOnlyMethod(m, '/invoices')).toThrow(ZohoReadOnlyViolation);
    expect(() => assertReadOnlyMethod('GET')).not.toThrow();
    expect(Object.getOwnPropertyNames(ZohoClient.prototype).filter((m) => /^(create|update|delete|post|put|patch|send|write)/i.test(m))).toEqual([]);
  });
  it('every API call after the token POST is a GET', async () => {
    const { client, calls } = setup(() => json({ code: 0, invoices: [], page_context: { has_more_page: false } }));
    await client.listInvoices('c1');
    expect(api(calls).every((c) => c.init.method === 'GET')).toBe(true);
    expect(calls.filter((c) => c.init.method !== 'GET').map((c) => c.url.host)).toEqual(['acc.test']);
  });
  it('maps code != 0 (200) to typed errors', async () => {
    const a = setup(() => json({ code: 1002, message: 'Contact does not exist.' }));
    await expect(a.client.getContact('zz')).rejects.toBeInstanceOf(ZohoNotFoundError);
    const b = setup(() => json({ code: 2, message: 'Invalid value passed' }));
    const e = await b.client.getContact('zz').catch((x) => x);
    expect(e).toBeInstanceOf(ZohoApiError);
    expect(e.zohoCode).toBe(2);
  });
  it('404 -> ZohoNotFoundError', async () => {
    const { client } = setup(() => new Response('{"code":1002,"message":"nf"}', { status: 404 }));
    await expect(client.getInvoicePdf('x')).rejects.toBeInstanceOf(ZohoNotFoundError);
  });
  it('secrets never appear in error messages (server echo, network error)', async () => {
    const { client } = setup(() => json({ code: 5, message: `echo ${SECRETS.secret} ${SECRETS.refresh} ATOKEN1` }));
    const e = await client.getContact('x').catch((x) => x);
    for (const s of [...Object.values(SECRETS), 'ATOKEN1']) expect(String(e.message) + String(e.stack?.split('\n')[0])).not.toContain(s);
    const net = new ZohoClient(cfg, { fetch: (async (u: any) => { if (String(u).includes('acc.test')) return json({ access_token: 'ATOKEN9', expires_in: 3600 }); throw new Error(`connect failed ${SECRETS.secret} ATOKEN9`); }) as any, maxRetries: 0 });
    const e2 = await net.getContact('x').catch((x) => x);
    expect(e2.message).not.toContain(SECRETS.secret);
    expect(e2.message).not.toContain('ATOKEN9');
    expect(JSON.stringify(net)).not.toContain(SECRETS.secret);
  });
  it('config loader reports missing names only', () => {
    expect(() => loadZohoConfigFromEnv({ ZOHO_CLIENT_ID: SECRETS.id })).toThrow(/ZOHO_CLIENT_SECRET/);
    try { loadZohoConfigFromEnv({ ZOHO_CLIENT_ID: SECRETS.id }); } catch (e) { expect((e as Error).message).not.toContain(SECRETS.id); }
  });
});

describe('pdf', () => {
  it('returns bytes and uses accept=pdf', async () => {
    const { client, calls } = setup(() => new Response(new Uint8Array([37, 80, 68, 70]), { headers: { 'content-type': 'application/pdf' } }));
    expect(Array.from(await client.getInvoicePdf('i1'))).toEqual([37, 80, 68, 70]);
    await client.getStatementPdf('c1', '2026-01-01', '2026-02-01');
    const a = api(calls);
    expect(a[0]!.url.searchParams.get('accept')).toBe('pdf');
    expect(a[1]!.url.pathname).toBe('/books/v3/contacts/c1/statements');
  });
});
