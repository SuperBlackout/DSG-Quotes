import { describe, expect, it, vi } from 'vitest';
import { createApi } from '@dsg/account-client';
import { createAccountStore } from './state.ts';

const account = {
  companyName: 'Acme', customerNumber: 'CUS-1', currency: 'USD', paymentTerms: 'Net 30', creditLimit: '5000.00', zohoAsOf: '2026-10-20T00:00:00Z',
  locations: [{ id: 'gid://shopify/CompanyLocation/1', name: 'Main', billingAddress: null, shippingAddress: null }],
  contacts: [{ name: 'Dana', email: 'dana@a.test', title: null, isMainContact: true, roles: ['Location admin'] }],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function setup(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchStub = vi.fn(async (url: any, init: any) => { calls.push({ url: String(url), init }); return handler(String(url), init); });
  let n = 0;
  const api = createApi({ getToken: async () => `tok-${++n}`, fetch: fetchStub as any, baseUrl: 'https://api.test/' });
  return { store: createAccountStore(api), calls };
}

describe('account store', () => {
  it('loads the account with a fresh bearer token from /a/v1/account', async () => {
    const { store, calls } = setup(() => json(account));
    expect(store.getState().status).toBe('loading');
    await store.load();
    const s = store.getState();
    expect(s.status).toBe('loaded');
    if (s.status === 'loaded') expect(s.account.companyName).toBe('Acme');
    expect(calls[0]!.url).toBe('https://api.test/a/v1/account'); // trailing slash on the base is tolerated
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
    await store.load();
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok-2');
  });

  it.each([
    [403, 'not_linked'], [401, 'unauthorized'], [429, 'rate_limited'], [503, 'unavailable'], [500, 'unknown'],
  ])('maps HTTP %i to %s', async (status, kind) => {
    const { store } = setup(() => json({ error: 'x' }, status));
    await store.load();
    const s = store.getState();
    expect(s.status).toBe('error');
    if (s.status === 'error') expect(s.error.kind).toBe(kind);
  });

  it('rejects a response that breaks the contract', async () => {
    const { store } = setup(() => json({ companyName: 'Acme' }));
    await store.load();
    const s = store.getState();
    expect(s.status === 'error' && s.error.kind).toBe('bad_response');
  });

  it('reports a network failure', async () => {
    const api = createApi({ getToken: async () => 't', fetch: (async () => { throw new Error('offline'); }) as any, baseUrl: 'https://api.test' });
    const store = createAccountStore(api);
    await store.load();
    const s = store.getState();
    expect(s.status === 'error' && s.error.kind).toBe('network');
  });

  it('drops a late response from a superseded load', async () => {
    let release!: (r: Response) => void;
    let first = true;
    const { store } = setup(() => (first ? ((first = false), new Promise<Response>((r) => (release = r))) : json({ ...account, companyName: 'Second' })));
    const slow = store.load();
    await Promise.resolve();
    await store.load();
    release(json({ ...account, companyName: 'First' }));
    await slow;
    const s = store.getState();
    expect(s.status === 'loaded' && s.account.companyName).toBe('Second');
  });
});
