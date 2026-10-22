import { HttpError, type Money, type ActivityItem, type ActivityPage, type DocKind, type StatementSummary } from '@dsg/contracts';
import type { Db } from './db.js';

const STALE_MS = 36 * 3600 * 1000;
export interface ActivityQuery { search?: string; kind?: DocKind; from?: string; to?: string; limit?: number; cursor?: string | null }
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ['invoice', 'payment', 'credit_note', 'sales_order'];

export const encodeCursor = (date: string, id: string) => Buffer.from(JSON.stringify([date, id])).toString('base64url');
export function decodeCursor(c: string): [string, string] {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && isRealDate(v[0]) && typeof v[1] === 'string') return [v[0], v[1]];
  } catch { /* fallthrough */ }
  throw new HttpError(400, 'invalid cursor');
}
/** Calendar-valid YYYY-MM-DD (rejects e.g. 2026-02-31, which Postgres would fail on with a 500). */
const isRealDate = (s: string) => {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
};
const money = (s: string): Money => s; // numeric(14,2) text is already 2dp

export class StatementService {
  constructor(private db: Db, private now: () => Date = () => new Date()) {}

  /** Returns null when the customer has never been synced. */
  async getSummary(customerId: string): Promise<StatementSummary | null> {
    const { rows } = await this.db.query(
      `select * from zoho_contact where zoho_customer_id = $1`, [customerId]);
    const c = rows[0];
    if (!c) return null;
    const today = this.now().toISOString().slice(0, 10);
    const od = await this.db.query(
      `select coalesce(sum(balance),0)::numeric(14,2)::text as s from zoho_document
       where zoho_customer_id = $1 and kind = 'invoice' and due_date < $2::date and balance > 0
         and lower(status) not in ('paid','void','draft')`, [customerId, today]);
    const synced: Date = c.synced_at;
    return {
      customerName: c.name, customerNumber: c.customer_number, currency: c.currency_code,
      paymentTerms: c.payment_terms_label ?? null,
      creditLimit: c.credit_limit == null ? null : money(c.credit_limit),
      outstanding: money(c.outstanding_receivable), overdue: money(od.rows[0].s),
      unusedCredits: money(c.unused_credits),
      asOf: synced.toISOString(), stale: this.now().getTime() - synced.getTime() > STALE_MS,
    };
  }

  async listActivity(customerId: string, q: ActivityQuery = {}): Promise<ActivityPage> {
    const limit = Math.min(100, Math.max(1, Math.trunc(q.limit ?? 25) || 25));
    if (q.kind && !KINDS.includes(q.kind)) throw new HttpError(400, 'invalid kind');
    for (const d of [q.from, q.to]) if (d && !isRealDate(d)) throw new HttpError(400, 'invalid date');
    const p: unknown[] = [customerId];
    let where = `zoho_customer_id = $1 and lower(status) not in ('draft','void')`;
    if (q.kind) { p.push(q.kind); where += ` and kind = $${p.length}`; }
    if (q.from) { p.push(q.from); where += ` and doc_date >= $${p.length}::date`; }
    if (q.to) { p.push(q.to); where += ` and doc_date <= $${p.length}::date`; }
    const needle = (q.search ?? '').trim().slice(0, 60);
    if (needle) {
      // Match the document number or the reference/PO text; escape LIKE wildcards so '%' and '_' are literal.
      p.push(`%${needle.replace(/[\\%_]/g, '\\$&')}%`);
      where += ` and (reference ilike $${p.length} escape '\\' or number ilike $${p.length} escape '\\')`;
    }
    if (q.cursor) {
      const [d, id] = decodeCursor(q.cursor);
      p.push(d, id);
      where += ` and (doc_date, id) < ($${p.length - 1}::date, $${p.length})`;
    }
    p.push(limit + 1);
    const { rows } = await this.db.query(
      `select id, kind, number, to_char(doc_date,'YYYY-MM-DD') as doc_date, to_char(due_date,'YYYY-MM-DD') as due_date,
              status, total::text as total, balance::text as balance, reference, source
       from zoho_document where ${where} order by doc_date desc, id desc limit $${p.length}`, p);
    const page = rows.slice(0, limit);
    const items: ActivityItem[] = page.map(r => ({
      id: r.id, kind: r.kind, number: r.number, date: r.doc_date, dueDate: r.due_date, status: r.status,
      total: money(r.total), balance: money(r.balance), reference: r.reference, source: r.source,
      hasPdf: r.kind === 'invoice' && r.source === 'zoho',
    }));
    const last = page[page.length - 1];
    return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.doc_date, last.id) : null };
  }
}
