/** Pure formatting helpers. Money stays a decimal string; no float math on amounts. */

const SYMBOLS: Record<string, string> = { USD: '$', CAD: 'CA$', EUR: '€', GBP: '£', AUD: 'A$' };

export function formatMoney(amount: string | null | undefined, currency = 'USD'): string {
  if (amount == null) return '—';
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(amount);
  if (!m) return '—';
  const [, neg, whole, cents] = m;
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sym = SYMBOLS[currency] ?? `${currency} `;
  return `${neg}${sym}${grouped}.${cents}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' (or ISO timestamp) -> 'Oct 20, 2026'. Date-only inputs are not timezone shifted. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return '—';
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return '—';
  return `${month} ${Number(m[3])}, ${m[1]}`;
}

/** ISO timestamp -> 'Oct 20, 2026, 14:05 UTC' (always UTC so output is deterministic). */
export function formatAsOf(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

const KIND_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  payment: 'Payment',
  credit_note: 'Credit note',
  sales_order: 'Sales order',
};
export const kindLabel = (kind: string): string => KIND_LABELS[kind] ?? kind;

/** 'partially_paid' -> 'Partially paid' */
export function statusLabel(status: string): string {
  const s = status.replace(/[_-]+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '—';
}

/** Badge tone for a document status (Shopify badge tones). */
export function statusTone(status: string): 'critical' | 'success' | 'info' | 'warning' | 'neutral' {
  const s = status.toLowerCase();
  if (s === 'overdue') return 'critical';
  if (s === 'paid' || s === 'received' || s === 'applied') return 'success';
  if (s === 'open' || s === 'sent' || s === 'confirmed') return 'info';
  if (s === 'partially_paid' || s === 'partially paid' || s === 'unpaid') return 'warning';
  return 'neutral';
}

/** Number shown in the grid: payments get a prefix since their numbers are bare digits. */
export const displayNumber = (kind: string, number: string): string => (kind === 'payment' ? `Pmt ${number}` : number);

/** One-line postal address from the account contract; empty parts are skipped. */
export function formatAddress(a: { address1: string | null; address2: string | null; city: string | null; province: string | null; zip: string | null; country: string | null } | null | undefined): string[] {
  if (!a) return [];
  const cityLine = [a.city, [a.province, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [a.address1, a.address2, cityLine, a.country].filter((x): x is string => !!x && x.trim() !== '');
}
