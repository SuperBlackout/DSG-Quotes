import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestPg, DEALER_A, DEALER_B, contacts, invoices, payments, salesOrders, type TestPg } from '@dsg/testkit';
import { ActivityPage, StatementSummary, type ZohoInvoice } from '@dsg/contracts';
import {
  AccountMapRepo, PdfLinkService, StatementService, upsertContact, upsertDocuments, replaceForCustomer,
  writeAudit, numToDecimal, hashToken,
} from './index.js';

let t: TestPg;
const NOW = new Date('2026-10-20T12:00:00Z');
beforeAll(async () => { t = await startTestPg(); });
afterAll(async () => { await t.stop(); });
beforeEach(async () => {
  await t.pool.query('truncate zoho_contact, zoho_document, pdf_link, account_map, access_audit');
});
const svc = () => new StatementService(t.pool, () => NOW);
const inv = (id: string, cust: string, date: string, over: Partial<ZohoInvoice> = {}): ZohoInvoice => ({
  invoice_id: id, customer_id: cust, invoice_number: `N-${id}`, date, due_date: date, status: 'sent',
  total: 10, balance: 10, currency_code: 'USD', reference_number: '', ...over,
});
async function seed() {
  for (const c of contacts) await upsertContact(t.pool, c);
  await upsertDocuments(t.pool, { invoices, payments, salesOrders });
}

describe('account map', () => {
  it('get active only, upsert, deactivate', async () => {
    const r = new AccountMapRepo(t.pool);
    const row = { shopifyCompanyId: DEALER_A.companyId, zohoCustomerId: DEALER_A.zohoId, customerNumber: DEALER_A.number, displayName: 'x' };
    await r.upsert(row);
    expect((await r.getByShopifyCompanyId(DEALER_A.companyId))?.zohoCustomerId).toBe(DEALER_A.zohoId);
    await r.upsert({ ...row, displayName: 'renamed' });
    expect((await r.getByShopifyCompanyId(DEALER_A.companyId))?.displayName).toBe('renamed');
    expect(await r.deactivate(DEALER_A.companyId)).toBe(true);
    expect(await r.getByShopifyCompanyId(DEALER_A.companyId)).toBeNull();
    expect(await r.getByShopifyCompanyId('nope')).toBeNull();
  });
});

describe('cache writers', () => {
  it('upserts are idempotent and update in place', async () => {
    await seed(); await seed();
    const n = await t.pool.query('select count(*)::int c from zoho_document');
    expect(n.rows[0].c).toBe(invoices.length + payments.length + salesOrders.length);
    await upsertDocuments(t.pool, { invoices: [{ ...invoices[0]!, balance: 0, status: 'paid' }] });
    const r = await t.pool.query(`select balance::text b, status from zoho_document where id='I-1'`);
    expect(r.rows[0]).toEqual({ b: '0.00', status: 'paid' });
    const raw = await t.pool.query(`select raw from zoho_document where id='I-1'`);
    expect(raw.rows[0].raw.invoice_number).toBe('INV-0001');
  });
  it('rounds via integer cents', async () => {
    expect(numToDecimal(1.005)).toBe('1.01');
    expect(numToDecimal(0.1 + 0.2)).toBe('0.30');
    expect(numToDecimal(-2.675)).toBe('-2.68');
    expect(numToDecimal(1234567.891)).toBe('1234567.89');
    expect(numToDecimal(-0.001)).toBe('0.00');
    await upsertDocuments(t.pool, { invoices: [inv('R', 'Z-x', '2026-01-01', { total: 19.999, balance: 1.005 })] });
    const r = await t.pool.query(`select total::text t, balance::text b from zoho_document where id='R'`);
    expect(r.rows[0]).toEqual({ t: '20.00', b: '1.01' });
  });
  it('does not overwrite a document owned by another customer', async () => {
    await upsertDocuments(t.pool, { invoices: [inv('X', DEALER_A.zohoId, '2026-01-01')] });
    await upsertDocuments(t.pool, { invoices: [inv('X', DEALER_B.zohoId, '2026-02-02', { total: 99 })] });
    const r = await t.pool.query(`select zoho_customer_id, total::text t from zoho_document where id='X'`);
    expect(r.rows).toEqual([{ zoho_customer_id: DEALER_A.zohoId, t: '10.00' }]);
  });
  it('replaceForCustomer deletes stale rows only for that customer', async () => {
    await seed();
    const res = await replaceForCustomer(t.pool, DEALER_A.zohoId, { contact: contacts[0]!, invoices: [invoices[0]!] });
    expect(res.deleted).toBe(3); // I-2, P-1, S-1
    const a = await t.pool.query(`select id from zoho_document where zoho_customer_id=$1`, [DEALER_A.zohoId]);
    expect(a.rows.map(r => r.id)).toEqual(['I-1']);
    const b = await t.pool.query(`select id from zoho_document where zoho_customer_id=$1`, [DEALER_B.zohoId]);
    expect(b.rows.map(r => r.id)).toEqual(['I-3']);
  });
  it('never caches draft or void documents (and a re-sync removes ones cached earlier)', async () => {
    await seed();
    const docs = {
      invoices: [invoices[0]!, inv('I-D', DEALER_A.zohoId, '2026-09-02', { status: 'draft' }), inv('I-V', DEALER_A.zohoId, '2026-09-03', { status: 'Void' })],
      creditNotes: [{ creditnote_id: 'C-D', customer_id: DEALER_A.zohoId, creditnote_number: 'CN-1', date: '2026-09-04', status: 'draft', total: 5, balance: 5, currency_code: 'USD', reference_number: '' }],
      salesOrders: [{ ...salesOrders[0]!, salesorder_id: 'S-D', status: 'draft' }],
    };
    await upsertDocuments(t.pool, docs);
    const ids = async () => (await t.pool.query(`select id from zoho_document where zoho_customer_id=$1 order by id`, [DEALER_A.zohoId])).rows.map(r => r.id);
    expect(await ids()).toEqual(['I-1', 'I-2', 'P-1', 'S-1']);
    // legacy rows already cached as draft/void are deleted by reconcile and hidden from reads meanwhile
    await t.pool.query(`insert into zoho_document (id, zoho_customer_id, kind, number, doc_date, due_date, status, total, balance) values ('I-OLD',$1,'invoice','N','2026-08-01','2026-08-02','draft',8000,8000)`, [DEALER_A.zohoId]);
    const s = (await svc().getSummary(DEALER_A.zohoId))!;
    expect(s.overdue).toBe('800.50');
    expect((await svc().listActivity(DEALER_A.zohoId, { limit: 100 })).items.map(i => i.id)).not.toContain('I-OLD');
    await replaceForCustomer(t.pool, DEALER_A.zohoId, { contact: contacts[0]!, ...docs });
    expect(await ids()).toEqual(['I-1']);
  });
  it('replaceForCustomer refuses to wipe a non-empty cache with an empty Zoho list unless forced', async () => {
    await seed();
    const guarded = await replaceForCustomer(t.pool, DEALER_A.zohoId, { contact: contacts[0]! });
    expect(guarded).toMatchObject({ deleted: 0, skippedDelete: true });
    const n = async () => (await t.pool.query(`select count(*)::int c from zoho_document where zoho_customer_id=$1`, [DEALER_A.zohoId])).rows[0].c;
    expect(await n()).toBe(4);
    const forced = await replaceForCustomer(t.pool, DEALER_A.zohoId, { contact: contacts[0]! }, { force: true });
    expect(forced.deleted).toBe(4);
    expect(await n()).toBe(0);
    // empty list for a customer with nothing cached is not a wipe
    expect((await replaceForCustomer(t.pool, DEALER_A.zohoId, { contact: contacts[0]! })).skippedDelete).toBeUndefined();
  });
  it('replaceForCustomer rolls back on failure and rejects foreign docs', async () => {
    await seed();
    await expect(replaceForCustomer(t.pool, DEALER_A.zohoId, { invoices: [invoices[2]!] })).rejects.toThrow();
    await expect(replaceForCustomer(t.pool, DEALER_A.zohoId, { invoices: [{ ...invoices[0]!, date: 'garbage' }] })).rejects.toThrow();
    const c = await t.pool.query(`select count(*)::int c from zoho_document where zoho_customer_id=$1`, [DEALER_A.zohoId]);
    expect(c.rows[0].c).toBe(4); // untouched: I-1, I-2, P-1, S-1
  });
});

describe('summary', () => {
  it('computes overdue, outstanding, asOf and returns valid contract shape', async () => {
    await seed();
    const s = (await svc().getSummary(DEALER_A.zohoId))!;
    StatementSummary.parse(s);
    expect(s.outstanding).toBe('1250.50');
    expect(s.overdue).toBe('800.50'); // I-1 only; I-2 due in future
    expect(s.creditLimit).toBe('10000.00');
    expect(s.paymentTerms).toBe('Net 30');
    expect(s.stale).toBe(false);
  });
  it('overdue ignores paid/void, zero balance, due today and future', async () => {
    await upsertContact(t.pool, contacts[0]!);
    await upsertDocuments(t.pool, { invoices: [
      inv('a', DEALER_A.zohoId, '2026-09-01', { due_date: '2026-10-19', balance: 5 }),
      inv('b', DEALER_A.zohoId, '2026-09-01', { due_date: '2026-10-19', balance: 7, status: 'void' }),
      inv('c', DEALER_A.zohoId, '2026-09-01', { due_date: '2026-10-19', balance: 9, status: 'paid' }),
      inv('d', DEALER_A.zohoId, '2026-09-01', { due_date: '2026-10-20', balance: 11 }),
      inv('e', DEALER_A.zohoId, '2026-09-01', { due_date: '2026-10-01', balance: 0 }),
      inv('f', DEALER_A.zohoId, '2026-09-01', { due_date: '2026-10-01', balance: 0.5 }),
    ] });
    expect((await svc().getSummary(DEALER_A.zohoId))!.overdue).toBe('5.50');
  });
  it('stale after 36h, fresh before; null when unknown', async () => {
    await seed();
    await t.pool.query(`update zoho_contact set synced_at = $1 where zoho_customer_id=$2`, [new Date(NOW.getTime() - 35 * 3600e3), DEALER_A.zohoId]);
    expect((await svc().getSummary(DEALER_A.zohoId))!.stale).toBe(false);
    await t.pool.query(`update zoho_contact set synced_at = $1 where zoho_customer_id=$2`, [new Date(NOW.getTime() - 37 * 3600e3), DEALER_A.zohoId]);
    const s = (await svc().getSummary(DEALER_A.zohoId))!;
    expect(s.stale).toBe(true);
    expect(s.asOf).toBe(new Date(NOW.getTime() - 37 * 3600e3).toISOString());
    expect(await svc().getSummary('Z-unknown')).toBeNull();
  });
});

describe('activity', () => {
  it('keyset pagination is stable across date ties with no dupes or gaps', async () => {
    const list: ZohoInvoice[] = [];
    for (let i = 0; i < 23; i++) list.push(inv(`T${String(i).padStart(2, '0')}`, DEALER_A.zohoId, i < 12 ? '2026-10-01' : `2026-09-${String(i).padStart(2, '0')}`));
    await upsertDocuments(t.pool, { invoices: list });
    const seen: string[] = [];
    let cursor: string | null = null, pages = 0;
    do {
      const p: ActivityPage = await svc().listActivity(DEALER_A.zohoId, { limit: 5, cursor });
      ActivityPage.parse(p);
      seen.push(...p.items.map(i => i.id));
      cursor = p.nextCursor; pages++;
      // concurrent insert mid-pagination must not cause dupes
      if (pages === 1) await upsertDocuments(t.pool, { invoices: [inv('T99', DEALER_A.zohoId, '2026-10-01')] });
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    const expected = (await t.pool.query(`select id from zoho_document where zoho_customer_id=$1 and id <> 'T99' order by doc_date desc, id desc`, [DEALER_A.zohoId])).rows.map(r => r.id);
    expect(seen.filter(i => i !== 'T99')).toEqual(expected);
    expect(pages).toBe(5);
  });
  it('filters, limit cap, money strings, bad input', async () => {
    await seed();
    const all = await svc().listActivity(DEALER_A.zohoId, { limit: 1000 });
    expect(all.items.map(i => i.id)).toEqual(['S-1', 'I-2', 'P-1', 'I-1']);
    expect(all.nextCursor).toBeNull();
    const p = all.items.find(i => i.id === 'P-1')!;
    expect(p).toMatchObject({ kind: 'payment', total: '500.00', balance: '100.00', dueDate: null, hasPdf: false, reference: 'CHK 4410' });
    expect(all.items.find(i => i.id === 'I-1')).toMatchObject({ total: '800.50', date: '2026-09-01', dueDate: '2026-10-01', hasPdf: true });
    expect((await svc().listActivity(DEALER_A.zohoId, { kind: 'invoice' })).items.map(i => i.id)).toEqual(['I-2', 'I-1']);
    expect((await svc().listActivity(DEALER_A.zohoId, { from: '2026-09-10', to: '2026-10-10' })).items.map(i => i.id)).toEqual(['I-2', 'P-1']);
    await expect(svc().listActivity(DEALER_A.zohoId, { cursor: 'garbage' })).rejects.toMatchObject({ status: 400 });
    // well-formed but not a real calendar date -> 400 (not a Postgres cast 500)
    const bad = Buffer.from(JSON.stringify(['2026-02-31', 'x'])).toString('base64url');
    await expect(svc().listActivity(DEALER_A.zohoId, { cursor: bad })).rejects.toMatchObject({ status: 400 });
    await expect(svc().listActivity(DEALER_A.zohoId, { from: '2026-13-01' })).rejects.toMatchObject({ status: 400 });
    await expect(svc().listActivity(DEALER_A.zohoId, { from: "x'; drop" })).rejects.toMatchObject({ status: 400 });
  });
});

describe('activity search', () => {
  const ids = async (customer: string, search: string) =>
    (await svc().listActivity(customer, { search, limit: 100 })).items.map(i => i.id).sort();
  it('matches reference/PO and document number, case-insensitive, scoped to the buyer', async () => {
    await seed();
    expect(await ids(DEALER_A.zohoId, 'po-77')).toEqual(['I-1']);
    expect(await ids(DEALER_A.zohoId, 'INV-0002')).toEqual(['I-2']);
    expect(await ids(DEALER_A.zohoId, 'phone')).toEqual(['S-1']);
    expect(await ids(DEALER_A.zohoId, 'nothing-like-this')).toEqual([]);
    // dealer B's invoice number must not be reachable from dealer A's search
    expect(await ids(DEALER_A.zohoId, 'INV-0003')).toEqual([]);
  });
  it('treats % and _ and backslash literally', async () => {
    await seed();
    expect(await ids(DEALER_A.zohoId, '%')).toEqual([]);
    expect(await ids(DEALER_A.zohoId, 'PO_77')).toEqual([]);
    expect(await ids(DEALER_A.zohoId, '\\')).toEqual([]);
  });
  it('blank search returns everything', async () => {
    await seed();
    expect((await ids(DEALER_A.zohoId, '   ')).length).toBe((await ids(DEALER_A.zohoId, '')).length);
  });
});

describe('pdf links', () => {
  it('single use, hash-only storage, 5 min expiry', async () => {
    const s = new PdfLinkService(t.pool);
    const { token, expiresAt } = await s.create(DEALER_A.zohoId, 'invoice', 'I-1');
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    const ms = new Date(expiresAt).getTime() - Date.now();
    expect(ms).toBeGreaterThan(4 * 60e3); expect(ms).toBeLessThanOrEqual(5 * 60e3 + 1000);
    const stored = await t.pool.query('select * from pdf_link');
    expect(stored.rows[0].token_hash).toBe(hashToken(token));
    expect(JSON.stringify(stored.rows)).not.toContain(token);
    expect(await s.redeem(token)).toEqual({ zohoCustomerId: DEALER_A.zohoId, docKind: 'invoice', docId: 'I-1' });
    expect(await s.redeem(token)).toBeNull();
  });
  it('concurrent redeem yields exactly one winner', async () => {
    const s = new PdfLinkService(t.pool);
    const { token } = await s.create(DEALER_A.zohoId, 'statement');
    const res = await Promise.all(Array.from({ length: 8 }, () => s.redeem(token)));
    expect(res.filter(Boolean)).toHaveLength(1);
  });
  it('expired, unknown and malformed all return null', async () => {
    const s = new PdfLinkService(t.pool);
    const { token } = await s.create(DEALER_A.zohoId, 'invoice', 'I-1');
    await t.pool.query(`update pdf_link set expires_at = now() - interval '1 second'`);
    expect(await s.redeem(token)).toBeNull();
    expect(await s.redeem('A'.repeat(43))).toBeNull();
    expect(await s.redeem('')).toBeNull();
  });
});

describe('audit', () => {
  it('writes rows', async () => {
    await writeAudit(t.pool, { shopifyCompanyId: DEALER_A.companyId, zohoCustomerId: DEALER_A.zohoId, action: 'view', outcome: 'ok' });
    await writeAudit(t.pool, { action: 'view', outcome: 'denied' });
    const r = await t.pool.query('select * from access_audit order by id');
    expect(r.rows).toHaveLength(2);
    expect(r.rows[1].zoho_customer_id).toBeNull();
  });
});

describe('CROSS-TENANT isolation', () => {
  it('dealer B never sees dealer A rows via any service method', async () => {
    await seed();
    const aIds = new Set(['I-1', 'I-2', 'P-1', 'S-1']);
    const s = svc();
    // every filter combination, paginated fully
    for (const kind of [undefined, 'invoice', 'payment', 'credit_note', 'sales_order'] as const) {
      let cursor: string | null = null;
      do {
        const p: ActivityPage = await s.listActivity(DEALER_B.zohoId, { kind, limit: 1, cursor });
        for (const i of p.items) expect(aIds.has(i.id)).toBe(false);
        cursor = p.nextCursor;
      } while (cursor);
    }
    expect((await s.listActivity(DEALER_B.zohoId, {})).items.map(i => i.id)).toEqual(['I-3']);
    // a cursor minted for A cannot leak A rows to B
    const aPage = await s.listActivity(DEALER_A.zohoId, { limit: 1 });
    const bPage = await s.listActivity(DEALER_B.zohoId, { cursor: aPage.nextCursor });
    expect(bPage.items.every(i => !aIds.has(i.id))).toBe(true);
    // summary
    const sb = (await s.getSummary(DEALER_B.zohoId))!;
    expect(sb.customerName).toBe(DEALER_B.name);
    expect(sb.outstanding).toBe('300.00');
    expect(sb.overdue).toBe('0.00'); // A's overdue I-1 must not count
    expect(sb.unusedCredits).toBe('0.00');
    // an unknown/empty id yields nothing
    expect(await s.getSummary('')).toBeNull();
    expect((await s.listActivity('', {})).items).toEqual([]);
    // tokens are bound to the issuing customer
    const link = await new PdfLinkService(t.pool).create(DEALER_B.zohoId, 'invoice', 'I-3');
    expect((await new PdfLinkService(t.pool).redeem(link.token))!.zohoCustomerId).toBe(DEALER_B.zohoId);
    // account map: B's company resolves only to B
    const m = new AccountMapRepo(t.pool);
    await m.upsert({ shopifyCompanyId: DEALER_A.companyId, zohoCustomerId: DEALER_A.zohoId, customerNumber: DEALER_A.number, displayName: 'A' });
    await m.upsert({ shopifyCompanyId: DEALER_B.companyId, zohoCustomerId: DEALER_B.zohoId, customerNumber: DEALER_B.number, displayName: 'B' });
    expect((await m.getByShopifyCompanyId(DEALER_B.companyId))!.zohoCustomerId).toBe(DEALER_B.zohoId);
  });
});
