import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpError } from '@dsg/contracts';
import { startTestPg, FakeZoho, DEALER_A, DEALER_B, contacts, type TestPg } from '@dsg/testkit';
import { AdminService } from './adminService.js';

let t: TestPg; let zoho: FakeZoho; let svc: AdminService;
const NEW = { shopifyCompanyId: 'gid://shopify/Company/99', zohoCustomerId: 'Z-99', customerNumber: 'CUS-99', displayName: 'New Co' };

beforeAll(async () => { t = await startTestPg(); });
afterAll(async () => { await t.stop(); });
beforeEach(async () => {
  zoho = new FakeZoho();
  zoho.contacts = [...contacts, { ...contacts[0]!, contact_id: 'Z-99', contact_name: 'New Co', customer_number: 'CUS-99' }];
  svc = new AdminService(t.pool, zoho);
  await t.pool.query('truncate account_map');
});
const status = async (p: Promise<unknown>) => { try { await p; return 200; } catch (e) { return e instanceof HttpError ? e.status : 500; } };
const rows = async () => (await t.pool.query('select * from account_map')).rows;

describe('AdminService.addMapping (the tenant boundary)', () => {
  it('verifies the Zoho contact, then links the company', async () => {
    await svc.addMapping(NEW);
    expect(await rows()).toHaveLength(1);
    expect((await svc.listAccounts())[0]).toMatchObject({ shopifyCompanyId: NEW.shopifyCompanyId, zohoCustomerId: 'Z-99', active: true });
  });
  it('refuses a customer number that differs from the Zoho contact, inserting nothing', async () => {
    expect(await status(svc.addMapping({ ...NEW, customerNumber: DEALER_A.number }))).toBe(400);
    expect(await rows()).toHaveLength(0);
  });
  it('refuses a Zoho id that does not exist, inserting nothing', async () => {
    expect(await status(svc.addMapping({ ...NEW, zohoCustomerId: 'Z-NOPE' }))).toBe(400);
    expect(await rows()).toHaveLength(0);
  });
  it('validates input', async () => {
    for (const bad of [{ shopifyCompanyId: 'Company/1' }, { zohoCustomerId: '' }, { customerNumber: '  ' }, { displayName: '' }, { displayName: 'x'.repeat(301) }]) {
      expect(await status(svc.addMapping({ ...NEW, ...bad })), JSON.stringify(bad)).toBe(400);
    }
    expect(await rows()).toHaveLength(0);
  });
  it('409 for a duplicate company, Zoho id or customer number', async () => {
    await svc.addMapping({ shopifyCompanyId: DEALER_A.companyId, zohoCustomerId: DEALER_A.zohoId, customerNumber: DEALER_A.number, displayName: DEALER_A.name });
    expect(await status(svc.addMapping({ shopifyCompanyId: DEALER_A.companyId, zohoCustomerId: DEALER_B.zohoId, customerNumber: DEALER_B.number, displayName: 'x' }))).toBe(409);
    expect(await status(svc.addMapping({ shopifyCompanyId: DEALER_B.companyId, zohoCustomerId: DEALER_A.zohoId, customerNumber: DEALER_A.number, displayName: 'x' }))).toBe(409);
    expect(await rows()).toHaveLength(1);
  });
  it('deactivates and reactivates; unknown company returns null', async () => {
    await svc.addMapping(NEW);
    expect(await svc.setActive(NEW.shopifyCompanyId, false)).toBe('Z-99');
    expect((await rows())[0].active).toBe(false);
    expect(await svc.setActive(NEW.shopifyCompanyId, true)).toBe('Z-99');
    expect((await rows())[0].active).toBe(true);
    expect(await svc.setActive('gid://shopify/Company/1234', true)).toBeNull();
  });
});
