import { describe, it, expect, vi } from 'vitest';
import { createApi } from '@dsg/account-client';
import { createStatementStore } from './state.ts';

const summary = {
  customerName: 'Acme', customerNumber: 'C-1', currency: 'USD', paymentTerms: 'Net 30', creditLimit: '5000.00',
  outstanding: '100.00', overdue: '0.00', unusedCredits: '0.00', asOf: '2026-10-20T00:00:00Z', stale: false,
};
const item = (id: string) => ({
  id, kind: 'invoice', number: `INV-${id}`, date: '2026-10-01', dueDate: null, status: 'sent',
  total: '10.00', balance: '10.00', reference: null, source: 'zoho', hasPdf: true,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function setup(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchStub = vi.fn(async (url: any, init: any) => { calls.push({ url: String(url), init }); return handler(String(url), init); });
  let n = 0;
  const getToken = vi.fn(async () => `tok-${++n}`);
  const api = createApi({ getToken, fetch: fetchStub as any, baseUrl: 'https://api.test' });
  const store = createStatementStore(api);
  return { store, calls, getToken };
}

const route = (url: string) =>
  url.includes('/summary') ? json(summary) : url.includes('cursor=c1') ? json({ items: [item('3')], nextCursor: null }) : json({ items: [item('1'), item('2')], nextCursor: 'c1' });

describe('statement store', () => {
  it('goes loading -> loaded', async () => {
    const { store } = setup(route);
    expect(store.getState().status).toBe('loading');
    await store.load();
    const s = store.getState();
    expect(s.status).toBe('loaded');
    expect(s.summary?.customerName).toBe('Acme');
    expect(s.items).toHaveLength(2);
    expect(s.nextCursor).toBe('c1');
  });

  it('appends on loadMore using nextCursor', async () => {
    const { store, calls } = setup(route);
    await store.load();
    await store.loadMore();
    expect(store.getState().items.map((i) => i.id)).toEqual(['1', '2', '3']);
    expect(store.getState().nextCursor).toBeNull();
    expect(calls.at(-1)!.url).toContain('cursor=c1');
  });

  it('maps 403 and 503', async () => {
    let r = setup(() => json({}, 403));
    await r.store.load();
    expect(r.store.getState().status).toBe('error');
    expect(r.store.getState().error?.kind).toBe('not_linked');
    r = setup(() => json({}, 503));
    await r.store.load();
    expect(r.store.getState().error?.kind).toBe('unavailable');
  });

  it('errors on schema-invalid responses', async () => {
    const { store } = setup((url) => (url.includes('/summary') ? json({ nope: 1 }) : json({ items: [], nextCursor: null })));
    await store.load();
    expect(store.getState().error?.kind).toBe('bad_response');
  });

  it('fetches a fresh token for every request and sends bearer auth', async () => {
    const { store, calls, getToken } = setup(route);
    await store.load();
    await store.loadMore();
    expect(getToken).toHaveBeenCalledTimes(3);
    const auths = calls.map((c) => (c.init.headers as any).Authorization);
    expect(new Set(auths).size).toBe(3);
    expect(auths[0]).toMatch(/^Bearer tok-/);
  });

  it('filters refetch from the start with query params', async () => {
    const { store, calls } = setup(route);
    await store.load();
    await store.setFilters({ type: 'payment', from: '2026-01-01' });
    const url = calls.at(-1)!.url;
    expect(url).toContain('type=payment');
    expect(url).toContain('from=2026-01-01');
    expect(url).not.toContain('cursor=');
  });

  it('mints pdf links via POST and exposes them as a link to click (no popup)', async () => {
    const { store, calls } = setup((url) =>
      url.includes('pdf-link') ? json({ url: 'https://files/x.pdf', expiresAt: '2026-10-20T01:00:00Z' }) : route(url));
    const open = vi.fn();
    (globalThis as any).open = open;
    await store.load();
    await store.downloadInvoice('1');
    expect(calls.at(-1)!.init.method).toBe('POST');
    expect(calls.at(-1)!.url).toBe('https://api.test/a/v1/invoices/1/pdf-link');
    expect(store.getState().pdfLink).toMatchObject({ url: 'https://files/x.pdf', label: 'Invoice PDF' });
    await store.downloadStatement();
    expect(calls.at(-1)!.url).toBe('https://api.test/a/v1/statement/pdf-link');
    expect(store.getState().pdfLink).toMatchObject({ url: 'https://files/x.pdf', label: 'Statement PDF' });
    expect(open).not.toHaveBeenCalled();
    delete (globalThis as any).open;
    store.clearPdf();
    expect(store.getState().pdfLink).toBeNull();
  });

  it('surfaces pdf errors and clears any stale link', async () => {
    let fail = false;
    const { store } = setup((url) => (url.includes('pdf-link') ? (fail ? json({}, 503) : json({ url: 'https://files/x.pdf', expiresAt: 'x' })) : route(url)));
    await store.load();
    await store.downloadInvoice('1');
    expect(store.getState().pdfLink).not.toBeNull();
    fail = true;
    await store.downloadInvoice('1');
    expect(store.getState().pdfLink).toBeNull();
    expect(store.getState().pdfError).toMatch(/temporarily/);
  });

  it('shows distinct messages for 400 and 429', async () => {
    const bad = setup((url) => (url.includes('pdf-link') ? json({}, 400) : route(url)));
    await bad.store.load();
    await bad.store.downloadStatement();
    expect(bad.store.getState().pdfError).toMatch(/not valid/);
    const lim = setup((url) => (url.includes('pdf-link') ? json({}, 429) : route(url)));
    await lim.store.load();
    await lim.store.downloadStatement();
    expect(lim.store.getState().pdfError).toMatch(/Too many requests/);
    const loadLim = setup(() => json({}, 429));
    await loadLim.store.load();
    expect(loadLim.store.getState().error?.kind).toBe('rate_limited');
    const loadBad = setup(() => json({}, 400));
    await loadBad.store.load();
    expect(loadBad.store.getState().error?.kind).toBe('bad_request');
  });
});
