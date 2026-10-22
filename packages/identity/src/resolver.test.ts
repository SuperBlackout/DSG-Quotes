import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { startTestPg, DEALER_A, type TestPg } from '@dsg/testkit';
import { AccountMapRepo } from '@dsg/statement';
import { ShopifyBuyerResolver, type ShopifyAdmin } from './index.js';

const SECRET = 'test-secret-test-secret-test-secret';
const KEY = 'client-id-123';
const SHOP = 'dsg-test.myshopify.com';
const CUST = 'gid://shopify/Customer/42';
const NOW = Date.parse('2026-10-20T12:00:00Z');
const sec = Math.floor(NOW / 1000);

let t: TestPg;
beforeAll(async () => { t = await startTestPg(); });
afterAll(async () => { await t.stop(); });

class FakeAdmin implements ShopifyAdmin {
  calls = 0; fail = false; vars: unknown[] = [];
  data: any = profile();
  async graphql<T>(_q: string, v: Record<string, unknown>): Promise<T> {
    this.calls++; this.vars.push(v);
    if (this.fail) throw new Error('boom secret-detail');
    return this.data;
  }
}
function profile(o: { roles?: string[]; extId?: string | null; companyId?: string; count?: number } = {}) {
  const p = {
    id: 'gid://shopify/CompanyContact/1',
    company: { id: o.companyId ?? DEALER_A.companyId, name: 'x', externalId: o.extId === undefined ? DEALER_A.number : o.extId },
    roleAssignments: { nodes: (o.roles ?? ['Location admin']).map(r => ({ role: { name: r }, companyLocation: null })) },
  };
  return { customer: { id: CUST, companyContactProfiles: Array.from({ length: o.count ?? 1 }, () => p) } };
}
const token = (claims: Record<string, unknown> = {}, o: { secret?: string; exp?: number; nbf?: number } = {}) => {
  const base: Record<string, unknown> = { aud: KEY, dest: `https://${SHOP}`, sub: CUST, ...claims };
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  return new SignJWT(base).setProtectedHeader({ alg: 'HS256' }).setIssuedAt(sec - 5)
    .setNotBefore(o.nbf ?? sec - 5).setExpirationTime(o.exp ?? sec + 60)
    .sign(new TextEncoder().encode(o.secret ?? SECRET));
};
const bearer = async (...a: Parameters<typeof token>) => `Bearer ${await token(...a)}`;

let admin: FakeAdmin; let logs: string[]; let clock = NOW;
const mk = () => new ShopifyBuyerResolver({
  apiSecret: SECRET, apiKey: KEY, allowedShops: [SHOP], admin, accountMap: new AccountMapRepo(t.pool),
  now: () => clock, log: e => logs.push(e),
});
beforeEach(async () => {
  admin = new FakeAdmin(); logs = []; clock = NOW;
  await t.pool.query('truncate account_map');
  await new AccountMapRepo(t.pool).upsert({ shopifyCompanyId: DEALER_A.companyId, zohoCustomerId: DEALER_A.zohoId, customerNumber: DEALER_A.number, displayName: DEALER_A.name });
});
const status = async (p: Promise<unknown>) => { try { await p; return 200; } catch (e: any) { return e.status ?? -1; } };

describe('token verification', () => {
  it('happy path', async () => {
    const b = await mk().resolve(await bearer());
    expect(b).toEqual({ shopifyCustomerId: CUST, shopifyCompanyId: DEALER_A.companyId, role: 'Location admin', zohoCustomerId: DEALER_A.zohoId, customerNumber: DEALER_A.number });
    expect(admin.vars[0]).toEqual({ id: CUST });
  });
  it('accepts within 10s skew, rejects beyond', async () => {
    expect(await status(mk().resolve(await bearer({}, { exp: sec - 5 })))).toBe(200);
    expect(await status(mk().resolve(await bearer({}, { exp: sec - 11 })))).toBe(401);
    expect(await status(mk().resolve(await bearer({}, { nbf: sec + 30 })))).toBe(401);
  });
  it('rejects wrong aud, dest, signature, missing/invalid sub, missing header', async () => {
    expect(await status(mk().resolve(await bearer({ aud: 'other' })))).toBe(401);
    expect(await status(mk().resolve(await bearer({ dest: 'https://evil.myshopify.com' })))).toBe(401);
    expect(await status(mk().resolve(await bearer({}, { secret: 'x'.repeat(40) })))).toBe(401);
    expect(await status(mk().resolve(await bearer({ sub: undefined })))).toBe(401);
    expect(await status(mk().resolve(await bearer({ sub: 'gid://shopify/Order/1' })))).toBe(401);
    expect(await status(mk().resolve(undefined))).toBe(401);
    expect(await status(mk().resolve('Bearer garbage'))).toBe(401);
    expect(admin.calls).toBe(0);
  });
  it('rejects alg=none', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const tok = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ aud: KEY, dest: `https://${SHOP}`, sub: CUST, exp: sec + 60 })}.`;
    expect(await status(mk().resolve(`Bearer ${tok}`))).toBe(401);
    expect(admin.calls).toBe(0);
  });
  it('error messages do not echo token', async () => {
    const tok = await token({ aud: 'other' });
    const e: any = await mk().resolve(`Bearer ${tok}`).catch(e => e);
    expect(e.message).not.toContain(tok);
    expect(e.message).toBe('Unauthorized');
  });
});

describe('authorisation rules', () => {
  it('denies ordering-only role', async () => {
    admin.data = profile({ roles: ['Ordering only'] });
    expect(await status(mk().resolve(await bearer()))).toBe(403);
  });
  it('allows configured extra roles', async () => {
    admin.data = profile({ roles: ['Ordering only'] });
    const r = new ShopifyBuyerResolver({ apiSecret: SECRET, apiKey: KEY, allowedShops: [SHOP], admin, accountMap: new AccountMapRepo(t.pool), allowedRoles: ['Ordering only'], now: () => clock });
    expect((await r.resolve(await bearer())).role).toBe('Ordering only');
  });
  it('denies zero / multiple companies and unknown customer', async () => {
    admin.data = profile({ count: 0 }); expect(await status(mk().resolve(await bearer()))).toBe(403);
    admin.data = profile({ count: 2 }); expect(await status(mk().resolve(await bearer()))).toBe(403);
    admin.data = { customer: null }; expect(await status(mk().resolve(await bearer()))).toBe(403);
  });
  it('denies externalId mismatch (and logs)', async () => {
    admin.data = profile({ extId: 'CUS-9999' });
    expect(await status(mk().resolve(await bearer()))).toBe(403);
    admin.data = profile({ extId: null });
    expect(await status(mk().resolve(await bearer()))).toBe(403);
    expect(logs).toContain('external_id_mismatch');
  });
  it('denies unmapped and deactivated company', async () => {
    admin.data = profile({ companyId: 'gid://shopify/Company/999' });
    expect(await status(mk().resolve(await bearer()))).toBe(403);
    admin.data = profile();
    await new AccountMapRepo(t.pool).deactivate(DEALER_A.companyId);
    expect(await status(mk().resolve(await bearer()))).toBe(403);
  });
});

describe('shopify availability and cache', () => {
  it('outage => 503', async () => {
    admin.fail = true;
    const e: any = await mk().resolve(await bearer()).catch(e => e);
    expect(e.status).toBe(503);
    expect(e.message).not.toContain('secret-detail');
  });
  it('cache hit avoids second admin call, expires after 60s, still verifies token', async () => {
    const r = mk();
    await r.resolve(await bearer()); await r.resolve(await bearer());
    expect(admin.calls).toBe(1);
    expect(await status(r.resolve(await bearer({ aud: 'other' })))).toBe(401);
    clock += 61_000;
    const later = `Bearer ${await new SignJWT({ aud: KEY, dest: `https://${SHOP}`, sub: CUST }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime(Math.floor(clock / 1000) + 60).sign(new TextEncoder().encode(SECRET))}`;
    await r.resolve(later);
    expect(admin.calls).toBe(2);
  });
  it('failures are not cached', async () => {
    const r = mk(); admin.fail = true;
    await status(r.resolve(await bearer())); admin.fail = false;
    expect(await status(r.resolve(await bearer()))).toBe(200);
  });
});
