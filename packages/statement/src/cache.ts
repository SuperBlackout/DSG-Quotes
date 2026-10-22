import type { Pool } from 'pg';
import type { ZohoContact, ZohoInvoice, ZohoPayment, ZohoCreditNote, ZohoSalesOrder } from '@dsg/contracts';
import { withTx, type Db } from './db.js';
import { numToDecimal } from './money.js';

export interface ZohoDocs {
  invoices?: ZohoInvoice[]; payments?: ZohoPayment[]; creditNotes?: ZohoCreditNote[]; salesOrders?: ZohoSalesOrder[];
}
type Row = {
  id: string; customer: string; kind: string; number: string; date: string; due: string | null; status: string;
  total: string; balance: string; currency: string; reference: string | null; raw: unknown;
};

/** Zoho status values that must never be cached or shown to dealers (internal / cancelled documents). */
export const HIDDEN_STATUSES = ['draft', 'void'] as const;
export const isBuyerVisibleStatus = (status: string | undefined) =>
  !(HIDDEN_STATUSES as readonly string[]).includes(String(status ?? '').trim().toLowerCase());

export function docRows(d: ZohoDocs): Row[] {
  const ref = (s?: string) => (s ? s : null);
  return [
    ...(d.invoices ?? []).map(i => ({ id: i.invoice_id, customer: i.customer_id, kind: 'invoice', number: i.invoice_number, date: i.date, due: i.due_date || null, status: i.status, total: numToDecimal(i.total), balance: numToDecimal(i.balance), currency: i.currency_code, reference: ref(i.reference_number), raw: i })),
    ...(d.payments ?? []).map(p => ({ id: p.payment_id, customer: p.customer_id, kind: 'payment', number: p.payment_number, date: p.date, due: null, status: 'paid', total: numToDecimal(p.amount), balance: numToDecimal(p.unused_amount), currency: p.currency_code, reference: ref(p.reference_number), raw: p })),
    ...(d.creditNotes ?? []).map(c => ({ id: c.creditnote_id, customer: c.customer_id, kind: 'credit_note', number: c.creditnote_number, date: c.date, due: null, status: c.status, total: numToDecimal(c.total), balance: numToDecimal(c.balance), currency: c.currency_code, reference: ref(c.reference_number), raw: c })),
    ...(d.salesOrders ?? []).map(s => ({ id: s.salesorder_id, customer: s.customer_id, kind: 'sales_order', number: s.salesorder_number, date: s.date, due: null, status: s.status, total: numToDecimal(s.total), balance: '0.00', currency: s.currency_code, reference: ref(s.reference_number), raw: s })),
  ].filter(r => isBuyerVisibleStatus(r.status));
}

export async function upsertContact(db: Db, c: ZohoContact): Promise<void> {
  await db.query(
    `insert into zoho_contact (zoho_customer_id, customer_number, name, currency_code, payment_terms_label, credit_limit, outstanding_receivable, unused_credits, raw, synced_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
     on conflict (zoho_customer_id) do update set
       customer_number = excluded.customer_number, name = excluded.name, currency_code = excluded.currency_code,
       payment_terms_label = excluded.payment_terms_label, credit_limit = excluded.credit_limit,
       outstanding_receivable = excluded.outstanding_receivable, unused_credits = excluded.unused_credits,
       raw = excluded.raw, synced_at = now()`,
    [c.contact_id, c.customer_number ?? '', c.contact_name, c.currency_code, c.payment_terms_label ?? null,
     c.credit_limit == null ? null : numToDecimal(c.credit_limit),
     numToDecimal(c.outstanding_receivable_amount), numToDecimal(c.unused_credits_receivable_amount), JSON.stringify(c)]);
}

/**
 * Idempotent upsert by document id. A row owned by a different customer is never overwritten
 * (guards against cross-tenant clobbering). Returns number of rows written.
 */
export async function upsertDocuments(db: Db, docs: ZohoDocs): Promise<number> {
  let n = 0;
  for (const r of docRows(docs)) {
    const res = await db.query(
      `insert into zoho_document (id, zoho_customer_id, kind, number, doc_date, due_date, status, total, balance, currency_code, reference, source, raw, synced_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'zoho',$12,now())
       on conflict (id) do update set
         kind = excluded.kind, number = excluded.number, doc_date = excluded.doc_date, due_date = excluded.due_date,
         status = excluded.status, total = excluded.total, balance = excluded.balance, currency_code = excluded.currency_code,
         reference = excluded.reference, raw = excluded.raw, synced_at = now()
       where zoho_document.zoho_customer_id = excluded.zoho_customer_id`,
      [r.id, r.customer, r.kind, r.number, r.date, r.due, r.status, r.total, r.balance, r.currency, r.reference, JSON.stringify(r.raw)]);
    n += res.rowCount ?? 0;
  }
  return n;
}

/**
 * Full reconciliation for one customer, in one transaction: upsert everything Zoho returned,
 * then delete zoho-sourced cached rows for that customer that Zoho no longer returns.
 */
export async function replaceForCustomer(
  pool: Pool, customerId: string, data: { contact?: ZohoContact } & ZohoDocs,
  opts: { force?: boolean } = {},
): Promise<{ upserted: number; deleted: number; skippedDelete?: boolean }> {
  const rows = docRows(data);
  if (rows.some(r => r.customer !== customerId)) throw new Error('document does not belong to customer');
  if (data.contact && data.contact.contact_id !== customerId) throw new Error('contact does not belong to customer');
  return withTx(pool, async c => {
    if (data.contact) await upsertContact(c, data.contact);
    const upserted = await upsertDocuments(c, data);
    // Mass-delete guard: an empty Zoho list for a customer that has cached docs is far more likely a
    // scope/param/API glitch than every document vanishing. Keep the cache unless explicitly forced.
    if (rows.length === 0 && !opts.force) {
      const n = await c.query(`select count(*)::int as n from zoho_document where zoho_customer_id = $1 and source = 'zoho'`, [customerId]);
      if (n.rows[0].n > 0) return { upserted, deleted: 0, skippedDelete: true };
    }
    const del = await c.query(
      `delete from zoho_document where zoho_customer_id = $1 and source = 'zoho' and id <> all($2::text[])`,
      [customerId, rows.map(r => r.id)]);
    return { upserted, deleted: del.rowCount ?? 0 };
  });
}
