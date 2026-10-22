import type { Pool } from 'pg';
import type { ZohoReader } from '@dsg/contracts';
import { replaceForCustomer } from '../cache.js';
import { writeAudit } from '../audit.js';

export interface SyncDeps { pool: Pool; zoho: ZohoReader; log?: (msg: string, meta?: Record<string, unknown>) => void }

export interface SyncResult {
  zohoCustomerId: string; ok: boolean; upserted?: number; deleted?: number; error?: string; warning?: string;
}

/** Strip anything that looks like a credential and bound the length before persisting/logging. */
export function safeMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw
    .replace(/(bearer|zoho-oauthtoken)\s+[A-Za-z0-9._~+\/=-]+/gi, '$1 [redacted]')
    .replace(/((?:access_token|refresh_token|client_secret|authorization|secret|token)["'\s:=]+)[^\s"',&}]+/gi, '$1[redacted]')
    .slice(0, 500);
}

export interface SyncOptions {
  /** Allow an empty Zoho document list to delete a customer's existing cache (default: skip the delete and warn). */
  force?: boolean;
}

async function recordEvent(deps: SyncDeps, customerId: string, detail: Record<string, unknown>): Promise<void> {
  try {
    await deps.pool.query('insert into sync_event (zoho_customer_id, kind, detail) values ($1,$2,$3)',
      [customerId, 'sync', JSON.stringify(detail)]);
  } catch (e) {
    deps.log?.('sync_event write failed', { zohoCustomerId: customerId, error: safeMessage(e) });
  }
}

/**
 * Full reconcile of one customer. All Zoho reads happen before any DB write, so a Zoho failure
 * leaves the existing cache untouched. Never throws; failures are returned and recorded.
 */
export async function syncCustomer(deps: SyncDeps, zohoCustomerId: string, opts: SyncOptions = {}): Promise<SyncResult> {
  const started = Date.now();
  try {
    const contact = await deps.zoho.getContact(zohoCustomerId);
    // Tenant boundary: never cache a contact that disagrees with the staff-entered mapping.
    const map = await deps.pool.query('select customer_number from account_map where zoho_customer_id = $1', [zohoCustomerId]);
    const mapped = map.rows[0]?.customer_number as string | undefined;
    if (mapped !== undefined && (contact.contact_id !== zohoCustomerId || (contact.customer_number ?? '') !== mapped)) {
      await deps.pool.query('update account_map set active = false where zoho_customer_id = $1', [zohoCustomerId]);
      const message = 'mapping mismatch: Zoho contact customer_number differs from account_map; mapping deactivated, nothing cached';
      deps.log?.('sync refused', { zohoCustomerId, error: message });
      await recordEvent(deps, zohoCustomerId, { status: 'error', message, ms: Date.now() - started });
      return { zohoCustomerId, ok: false, error: message };
    }
    const invoices = await deps.zoho.listInvoices(zohoCustomerId);
    const payments = await deps.zoho.listPayments(zohoCustomerId);
    const creditNotes = await deps.zoho.listCreditNotes(zohoCustomerId);
    const salesOrders = await deps.zoho.listSalesOrders(zohoCustomerId);
    const { upserted, deleted, skippedDelete } = await replaceForCustomer(deps.pool, zohoCustomerId,
      { contact, invoices, payments, creditNotes, salesOrders }, { force: opts.force });
    if (skippedDelete) {
      const warning = 'Zoho returned zero documents but the cache has some; delete skipped (use force to override)';
      deps.log?.('sync warning', { zohoCustomerId, warning });
      await recordEvent(deps, zohoCustomerId, { status: 'warning', warning, upserted, deleted: 0, ms: Date.now() - started });
      return { zohoCustomerId, ok: true, upserted, deleted: 0, warning };
    }
    await recordEvent(deps, zohoCustomerId, { status: 'ok', upserted, deleted, ms: Date.now() - started });
    return { zohoCustomerId, ok: true, upserted, deleted };
  } catch (e) {
    const message = safeMessage(e);
    deps.log?.('sync failed', { zohoCustomerId, error: message });
    await recordEvent(deps, zohoCustomerId, { status: 'error', message, ms: Date.now() - started });
    return { zohoCustomerId, ok: false, error: message };
  }
}

export interface SyncAllResult { total: number; ok: number; failed: number; results: SyncResult[] }

/** Sequential (API-budget friendly) sync of every active account_map customer; failures are isolated. */
export async function syncAll(deps: SyncDeps, opts: { shouldStop?: () => boolean } = {}): Promise<SyncAllResult> {
  const { rows } = await deps.pool.query(
    'select distinct zoho_customer_id from account_map where active = true order by zoho_customer_id');
  const results: SyncResult[] = [];
  for (const r of rows) {
    if (opts.shouldStop?.()) break;
    results.push(await syncCustomer(deps, r.zoho_customer_id));
  }
  const ok = results.filter(r => r.ok).length;
  try {
    await writeAudit(deps.pool, { action: 'sync_all', outcome: `ok=${ok} failed=${results.length - ok}` });
  } catch (e) { deps.log?.('audit write failed', { error: safeMessage(e) }); }
  return { total: results.length, ok, failed: results.length - ok, results };
}
