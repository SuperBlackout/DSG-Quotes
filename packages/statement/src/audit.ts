import type { Db } from './db.js';

export interface AuditEntry { shopifyCompanyId?: string | null; zohoCustomerId?: string | null; action: string; outcome: string }
export async function writeAudit(db: Db, e: AuditEntry): Promise<void> {
  await db.query(
    'insert into access_audit (shopify_company_id, zoho_customer_id, action, outcome) values ($1,$2,$3,$4)',
    [e.shopifyCompanyId ?? null, e.zohoCustomerId ?? null, e.action, e.outcome]);
}
