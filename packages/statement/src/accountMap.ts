import type { Db } from './db.js';

export interface AccountMapRow {
  shopifyCompanyId: string; zohoCustomerId: string; customerNumber: string; displayName: string; active: boolean;
}
const map = (r: any): AccountMapRow => ({
  shopifyCompanyId: r.shopify_company_id, zohoCustomerId: r.zoho_customer_id,
  customerNumber: r.customer_number, displayName: r.display_name, active: r.active,
});

export class AccountMapRepo {
  constructor(private db: Db) {}

  /** Active mapping only; deactivated companies resolve to null. */
  async getByShopifyCompanyId(shopifyCompanyId: string): Promise<AccountMapRow | null> {
    const { rows } = await this.db.query(
      'select * from account_map where shopify_company_id = $1 and active = true', [shopifyCompanyId]);
    return rows[0] ? map(rows[0]) : null;
  }

  async upsert(m: Omit<AccountMapRow, 'active'> & { active?: boolean }): Promise<AccountMapRow> {
    const { rows } = await this.db.query(
      `insert into account_map (shopify_company_id, zoho_customer_id, customer_number, display_name, active)
       values ($1,$2,$3,$4,$5)
       on conflict (shopify_company_id) do update set
         zoho_customer_id = excluded.zoho_customer_id, customer_number = excluded.customer_number,
         display_name = excluded.display_name, active = excluded.active
       returning *`,
      [m.shopifyCompanyId, m.zohoCustomerId, m.customerNumber, m.displayName, m.active ?? true]);
    return map(rows[0]);
  }

  /** Returns true if a row was deactivated. */
  async deactivate(shopifyCompanyId: string): Promise<boolean> {
    const r = await this.db.query('update account_map set active = false where shopify_company_id = $1', [shopifyCompanyId]);
    return (r.rowCount ?? 0) > 0;
  }
}
