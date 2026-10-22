import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { startTestPg, FakeZoho, DEALER_A, DEALER_B, type TestPg } from '@dsg/testkit';
import { AccountMapRepo } from '../accountMap.js';
import { syncCustomer, syncAll, InMemorySyncQueue, verifyZohoWebhook, parseWebhook, signWebhook } from './index.js';

let t: TestPg;
beforeAll(async () => { t = await startTestPg(); });
afterAll(async () => { await t.stop(); });
beforeEach(async () => {
  await t.pool.query('truncate zoho_contact, zoho_document, account_map, sync_event, access_audit');
});
const mapBoth = async () => {
  const r = new AccountMapRepo(t.pool);
  for (const d of [DEALER_A, DEALER_B])
    await r.upsert({ shopifyCompanyId: d.companyId, zohoCustomerId: d.zohoId, customerNumber: d.number, displayName: d.name });
};
const count = async (cust: string) =>
  Number((await t.pool.query('select count(*) from zoho_document where zoho_customer_id=$1', [cust])).rows[0].count);
const events = async (cust: string) =>
  (await t.pool.query('select detail from sync_event where zoho_customer_id=$1 order by id', [cust])).rows.map(r => r.detail);

describe('syncCustomer', () => {
  it('populates cache and logs ok event', async () => {
    const zoho = new FakeZoho();
    const r = await syncCustomer({ pool: t.pool, zoho }, DEALER_A.zohoId);
    expect(r.ok).toBe(true);
    expect(await count(DEALER_A.zohoId)).toBe(4);
    expect(await count(DEALER_B.zohoId)).toBe(0);
    expect((await events(DEALER_A.zohoId))[0].status).toBe('ok');
  });

  it('Zoho outage keeps old cache and logs error without secrets', async () => {
    const zoho = new FakeZoho();
    await syncCustomer({ pool: t.pool, zoho }, DEALER_A.zohoId);
    zoho.failNext = 1;
    zoho.getContact = async () => { throw new Error('boom Bearer abc123SECRET access_token=xyz999'); };
    const r = await syncCustomer({ pool: t.pool, zoho }, DEALER_A.zohoId);
    expect(r.ok).toBe(false);
    expect(await count(DEALER_A.zohoId)).toBe(4);
    const ev = (await events(DEALER_A.zohoId)).at(-1);
    expect(ev.status).toBe('error');
    expect(JSON.stringify(ev)).not.toMatch(/abc123SECRET|xyz999/);
  });

  it('partial failure mid-fetch leaves cache untouched', async () => {
    const zoho = new FakeZoho();
    await syncCustomer({ pool: t.pool, zoho }, DEALER_A.zohoId);
    zoho.listSalesOrders = async () => { throw new Error('zoho unavailable'); };
    zoho.invoices = [];
    expect((await syncCustomer({ pool: t.pool, zoho }, DEALER_A.zohoId)).ok).toBe(false);
    expect(await count(DEALER_A.zohoId)).toBe(4);
  });

  it('docs deleted in Zoho disappear', async () => {
    const zoho = new FakeZoho();
    await syncCustomer({ pool: t.pool, zoho }, DEALER_A.zohoId);
    zoho.invoices = zoho.invoices.filter(i => i.invoice_id !== 'I-1');
    zoho.salesOrders = [];
    const r = await syncCustomer({ pool: t.pool, zoho }, DEALER_A.zohoId);
    expect(r.deleted).toBe(2);
    expect(await count(DEALER_A.zohoId)).toBe(2);
  });
});

describe('mapping verification at sync', () => {
  it('mismatched customer_number: nothing cached, mapping deactivated, error event written', async () => {
    const r = new AccountMapRepo(t.pool);
    // staff mapped Dealer A's Zoho id under Dealer B's customer number
    await r.upsert({ shopifyCompanyId: DEALER_A.companyId, zohoCustomerId: DEALER_A.zohoId, customerNumber: DEALER_B.number, displayName: 'x' });
    const res = await syncCustomer({ pool: t.pool, zoho: new FakeZoho() }, DEALER_A.zohoId);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/mapping mismatch/);
    expect(await count(DEALER_A.zohoId)).toBe(0);
    expect((await t.pool.query('select count(*)::int n from zoho_contact')).rows[0].n).toBe(0);
    expect(await r.getByShopifyCompanyId(DEALER_A.companyId)).toBeNull(); // inactive => unreadable
    expect((await events(DEALER_A.zohoId))[0]).toMatchObject({ status: 'error' });
  });
  it('matching mapping syncs normally and stays active', async () => {
    await mapBoth();
    expect((await syncCustomer({ pool: t.pool, zoho: new FakeZoho() }, DEALER_A.zohoId)).ok).toBe(true);
    expect(await new AccountMapRepo(t.pool).getByShopifyCompanyId(DEALER_A.companyId)).not.toBeNull();
  });
});

describe('empty-list guard', () => {
  it('empty Zoho lists keep the cache and log a warning; force wipes', async () => {
    const zoho = new FakeZoho();
    await syncCustomer({ pool: t.pool, zoho }, DEALER_A.zohoId);
    zoho.invoices = []; zoho.payments = []; zoho.salesOrders = []; zoho.creditNotes = [];
    const r = await syncCustomer({ pool: t.pool, zoho }, DEALER_A.zohoId);
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/delete skipped/);
    expect(r.deleted).toBe(0);
    expect(await count(DEALER_A.zohoId)).toBe(4);
    expect((await events(DEALER_A.zohoId)).at(-1)).toMatchObject({ status: 'warning' });
    const f = await syncCustomer({ pool: t.pool, zoho }, DEALER_A.zohoId, { force: true });
    expect(f.deleted).toBe(4);
    expect(await count(DEALER_A.zohoId)).toBe(0);
  });
});

describe('syncAll', () => {
  it('isolates per-customer failures and skips inactive', async () => {
    await mapBoth();
    const zoho = new FakeZoho();
    const orig = zoho.getContact.bind(zoho);
    zoho.getContact = async id => { if (id === DEALER_A.zohoId) throw new Error('nope'); return orig(id); };
    const res = await syncAll({ pool: t.pool, zoho });
    expect(res.total).toBe(2); expect(res.failed).toBe(1); expect(res.ok).toBe(1);
    expect(await count(DEALER_B.zohoId)).toBe(1);
    await new AccountMapRepo(t.pool).deactivate(DEALER_B.companyId);
    expect((await syncAll({ pool: t.pool, zoho })).total).toBe(1);
  });
});

describe('InMemorySyncQueue', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  it('coalesces signals within the window per customer', async () => {
    const handler = vi.fn(async (_id: string) => {});
    const q = new InMemorySyncQueue(handler, { debounceMs: 30_000 });
    for (let i = 0; i < 5; i++) { await q.enqueueSync('A'); await vi.advanceTimersByTimeAsync(2000); }
    await q.enqueueSync('B');
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handler.mock.calls.map(c => c[0]).sort()).toEqual(['A', 'B']);
    await q.enqueueSync('A');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handler).toHaveBeenCalledTimes(3);
    await q.close();
  });
  it('close cancels pending', async () => {
    const handler = vi.fn(async () => {});
    const q = new InMemorySyncQueue(handler);
    await q.enqueueSync('A'); await q.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('webhook', () => {
  const secret = 's3cret';
  const body = JSON.stringify({ invoice: { invoice_id: 'I-1', customer_id: DEALER_A.zohoId } });
  it('valid, invalid, tampered', () => {
    const sig = signWebhook(body, secret);
    const h = { 'X-Zoho-Webhook-Signature': sig };
    expect(verifyZohoWebhook(h, body, secret)).toBe(true);
    expect(verifyZohoWebhook(h, body, 'other')).toBe(false);
    expect(verifyZohoWebhook(h, body.replace('I-1', 'I-2'), secret)).toBe(false);
    expect(verifyZohoWebhook({}, body, secret)).toBe(false);
    expect(verifyZohoWebhook({ 'x-zoho-webhook-signature': 'zz' }, body, secret)).toBe(false);
    expect(verifyZohoWebhook(h, body, '')).toBe(false);
  });
  it('maps known customer, ignores unmapped/unknown/malformed', async () => {
    await mapBoth();
    expect(await parseWebhook(t.pool, body)).toBe(DEALER_A.zohoId);
    expect(await parseWebhook(t.pool, JSON.stringify({ customer_id: 'Z-999' }))).toBeNull();
    expect(await parseWebhook(t.pool, '{}')).toBeNull();
    expect(await parseWebhook(t.pool, 'not json')).toBeNull();
    await new AccountMapRepo(t.pool).deactivate(DEALER_A.companyId);
    expect(await parseWebhook(t.pool, body)).toBeNull();
  });
});
