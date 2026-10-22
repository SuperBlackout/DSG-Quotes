import { createHash, randomBytes } from 'node:crypto';
import type { DocKind } from '@dsg/contracts';
import type { Db } from './db.js';

const TTL_MS = 5 * 60 * 1000;
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
export interface RedeemedLink { zohoCustomerId: string; docKind: string; docId: string | null }

export class PdfLinkService {
  constructor(private db: Db) {}

  /** Returns the raw token (never stored) and its expiry. Only the sha256 hash is persisted. */
  async create(customerId: string, kind: DocKind | 'statement', docId?: string): Promise<{ token: string; expiresAt: string }> {
    const token = randomBytes(32).toString('base64url');
    const { rows } = await this.db.query(
      `insert into pdf_link (token_hash, zoho_customer_id, doc_kind, doc_id, expires_at)
       values ($1,$2,$3,$4, now() + ($5 || ' milliseconds')::interval) returning expires_at`,
      [hashToken(token), customerId, kind, docId ?? null, String(TTL_MS)]);
    return { token, expiresAt: (rows[0].expires_at as Date).toISOString() };
  }

  /** Atomic single-use redeem. Null for unknown, used or expired alike. */
  async redeem(token: string): Promise<RedeemedLink | null> {
    if (typeof token !== 'string' || token.length < 20 || token.length > 128) return null;
    const { rows } = await this.db.query(
      `update pdf_link set used_at = now()
       where token_hash = $1 and used_at is null and expires_at > now()
       returning zoho_customer_id, doc_kind, doc_id`, [hashToken(token)]);
    const r = rows[0];
    return r ? { zohoCustomerId: r.zoho_customer_id, docKind: r.doc_kind, docId: r.doc_id } : null;
  }

  /**
   * Gives a redeemed token back (e.g. the Zoho fetch failed with a 5xx), so the buyer or a retry can use it
   * again until it expires. Only call after redeem() succeeded and no bytes were delivered.
   */
  async release(token: string): Promise<void> {
    await this.db.query('update pdf_link set used_at = null where token_hash = $1', [hashToken(token)]);
  }
}
