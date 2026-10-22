import { HttpError } from '@dsg/contracts';
import type { ZohoReader } from '@dsg/contracts';
import type { Db } from './db.js';

export const SHOPIFY_COMPANY_GID = /^gid:\/\/shopify\/Company\/\d+$/;

export interface LinkedAccount {
  shopifyCompanyId: string; zohoCustomerId: string; customerNumber: string; displayName: string; active: boolean;
  createdAt: string; lastSyncKind: string | null; lastSyncAt: string | null; cacheSyncedAt: string | null;
}
export interface AuditRow { id: string; shopifyCompanyId: string | null; zohoCustomerId: string | null; action: string; outcome: string; createdAt: string }
export interface SyncRow { id: string; zohoCustomerId: string | null; kind: string; detail: unknown; createdAt: string }
export interface NewMapping { shopifyCompanyId: string; zohoCustomerId: string; customerNumber: string; displayName: string }

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export class AdminService {
  constructor(private db: Db, private zoho: ZohoReader) {}

  async listAccounts(): Promise<LinkedAccount[]> {
    const { rows } = await this.db.query(
      `select m.*, e.kind as sync_kind, e.created_at as sync_at, c.synced_at as cache_synced_at
       from account_map m
       left join lateral (select kind, created_at from sync_event s where s.zoho_customer_id = m.zoho_customer_id
                          order by created_at desc, id desc limit 1) e on true
       left join zoho_contact c on c.zoho_customer_id = m.zoho_customer_id
       order by m.display_name, m.shopify_company_id`);
    return rows.map(r => ({
      shopifyCompanyId: r.shopify_company_id, zohoCustomerId: r.zoho_customer_id, customerNumber: r.customer_number,
      displayName: r.display_name, active: r.active, createdAt: r.created_at.toISOString(),
      lastSyncKind: r.sync_kind ?? null, lastSyncAt: iso(r.sync_at), cacheSyncedAt: iso(r.cache_synced_at),
    }));
  }

  /** Includes inactive rows (staff need to see and reactivate them). */
  async getAccount(shopifyCompanyId: string): Promise<LinkedAccount | null> {
    return (await this.listAccounts()).find(a => a.shopifyCompanyId === shopifyCompanyId) ?? null;
  }

  async recentAudit(limit = 100): Promise<AuditRow[]> {
    const { rows } = await this.db.query('select * from access_audit order by id desc limit $1', [clamp(limit)]);
    return rows.map(r => ({ id: String(r.id), shopifyCompanyId: r.shopify_company_id, zohoCustomerId: r.zoho_customer_id,
      action: r.action, outcome: r.outcome, createdAt: r.created_at.toISOString() }));
  }

  async recentSync(limit = 100): Promise<SyncRow[]> {
    const { rows } = await this.db.query('select * from sync_event order by id desc limit $1', [clamp(limit)]);
    return rows.map(r => ({ id: String(r.id), zohoCustomerId: r.zoho_customer_id, kind: r.kind, detail: r.detail,
      createdAt: r.created_at.toISOString() }));
  }

  /** Validates and inserts. 400 on bad input, 409 if any unique key (company, zoho id, customer number) exists. */
  async addMapping(input: Partial<Record<keyof NewMapping, unknown>>): Promise<NewMapping> {
    const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const m: NewMapping = {
      shopifyCompanyId: s(input.shopifyCompanyId), zohoCustomerId: s(input.zohoCustomerId),
      customerNumber: s(input.customerNumber), displayName: s(input.displayName),
    };
    if (!SHOPIFY_COMPANY_GID.test(m.shopifyCompanyId)) throw new HttpError(400, 'shopifyCompanyId must look like gid://shopify/Company/<digits>');
    if (!m.zohoCustomerId) throw new HttpError(400, 'zohoCustomerId is required');
    if (!m.customerNumber) throw new HttpError(400, 'customerNumber is required');
    if (!m.displayName) throw new HttpError(400, 'displayName is required');
    if (m.zohoCustomerId.length > 100 || m.customerNumber.length > 100 || m.displayName.length > 300) throw new HttpError(400, 'value too long');
    // Tenant boundary: the Zoho contact behind this id must really carry this customer number.
    let contact;
    try { contact = await this.zoho.getContact(m.zohoCustomerId); }
    catch { throw new HttpError(400, 'could not verify the Zoho contact for that zohoCustomerId'); }
    if (contact.contact_id !== m.zohoCustomerId || (contact.customer_number ?? '') !== m.customerNumber) {
      throw new HttpError(400, 'Zoho contact does not match: its customer number differs from the one entered');
    }
    try {
      await this.db.query(
        'insert into account_map (shopify_company_id, zoho_customer_id, customer_number, display_name) values ($1,$2,$3,$4)',
        [m.shopifyCompanyId, m.zohoCustomerId, m.customerNumber, m.displayName]);
    } catch (e: any) {
      if (e?.code === '23505') throw new HttpError(409, 'a mapping with that Shopify company, Zoho id or customer number already exists');
      throw e;
    }
    return m;
  }

  /** Returns the affected row's zoho id, or null if no such mapping. */
  async setActive(shopifyCompanyId: string, active: boolean): Promise<string | null> {
    const r = await this.db.query(
      'update account_map set active = $2 where shopify_company_id = $1 returning zoho_customer_id', [shopifyCompanyId, active]);
    return r.rows[0]?.zoho_customer_id ?? null;
  }
}
const clamp = (n: number) => Math.min(500, Math.max(1, Math.trunc(n) || 100));
