import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';

export const SIGNATURE_HEADER = 'x-zoho-webhook-signature';

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  for (const k of Object.keys(headers)) if (k.toLowerCase() === name) {
    const v = headers[k]; return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

/** HMAC-SHA256 over the exact raw body; signature is hex (optionally prefixed "sha256="). */
export function verifyZohoWebhook(
  headers: Record<string, string | string[] | undefined>, rawBody: string | Uint8Array, secret: string,
): boolean {
  if (!secret) return false;
  const sig = header(headers, SIGNATURE_HEADER)?.trim().replace(/^sha256=/i, '');
  if (!sig || !/^[0-9a-f]{64}$/i.test(sig)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(sig, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signWebhook(rawBody: string | Uint8Array, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** Pull candidate Zoho customer ids from the (untrusted) payload. */
export function extractCustomerIds(payload: unknown): string[] {
  const out = new Set<string>();
  const visit = (o: unknown, depth: number) => {
    if (!o || typeof o !== 'object' || depth > 4) return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if ((k === 'customer_id' || k === 'contact_id') && (typeof v === 'string' || typeof v === 'number') && String(v)) out.add(String(v));
      else if (v && typeof v === 'object') visit(v, depth + 1);
    }
  };
  visit(payload, 0);
  return [...out];
}

/** Returns the mapped, active Zoho customer id, or null for malformed/unknown/unmapped payloads. */
export async function parseWebhook(pool: Pool, rawBody: string): Promise<string | null> {
  let payload: unknown;
  try { payload = JSON.parse(rawBody); } catch { return null; }
  const ids = extractCustomerIds(payload);
  if (ids.length !== 1) return null; // ambiguous or missing
  const { rows } = await pool.query(
    'select 1 from account_map where zoho_customer_id = $1 and active = true limit 1', [ids[0]]);
  return rows.length ? ids[0]! : null;
}
