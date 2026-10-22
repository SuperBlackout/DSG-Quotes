import { it, expect } from 'vitest';
import { FetchShopifyAdmin } from './shopifyAdmin.js';

function stub() {
  const calls: { url: string; body: string }[] = [];
  let n = 0;
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, body: String(init.body) });
    if (url.endsWith('/admin/oauth/access_token')) {
      n++;
      return new Response(JSON.stringify({ access_token: `tok${n}`, expires_in: 86399 }), { status: 200 });
    }
    const t = init.headers['x-shopify-access-token'];
    if (t === 'tok1' && (stub as any).expire1) return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({ data: { ok: t } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

it('fetches a token with client credentials once and reuses it', async () => {
  const { calls, fetchImpl } = stub();
  const a = new FetchShopifyAdmin({ shopDomain: 'x.myshopify.com', clientId: 'id', clientSecret: 'sec', fetchImpl });
  expect(await a.graphql('q', {})).toEqual({ ok: 'tok1' });
  await a.graphql('q', {});
  expect(calls.filter((c) => c.url.endsWith('/admin/oauth/access_token'))).toHaveLength(1);
  expect(calls[0]!.body).toContain('grant_type=client_credentials');
});

it('refreshes when expired and on a 401', async () => {
  let t = 0; const { calls, fetchImpl } = stub();
  const a = new FetchShopifyAdmin({ shopDomain: 'x.myshopify.com', clientId: 'id', clientSecret: 'sec', fetchImpl, now: () => t });
  await a.graphql('q', {});
  t += 86_400_000;
  expect(await a.graphql('q', {})).toEqual({ ok: 'tok2' });
  (stub as any).expire1 = false;
  expect(calls.filter((c) => c.url.endsWith('/admin/oauth/access_token'))).toHaveLength(2);
});

it('a failed token request becomes a generic 503', async () => {
  const fetchImpl = (async () => new Response('no', { status: 403 })) as unknown as typeof fetch;
  const a = new FetchShopifyAdmin({ shopDomain: 'x.myshopify.com', clientId: 'id', clientSecret: 'sec', fetchImpl });
  await expect(a.graphql('q', {})).rejects.toMatchObject({ status: 503 });
});

it('static token still works for legacy apps', async () => {
  const { fetchImpl } = stub();
  const a = new FetchShopifyAdmin({ shopDomain: 'x.myshopify.com', accessToken: 'legacy', fetchImpl });
  expect(await a.graphql('q', {})).toEqual({ ok: 'legacy' });
});
