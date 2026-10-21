import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Reply-To addressing: `q-<quoteId>-<token>@<reply domain>`.
 *
 * The token is `<role><24 hex of HMAC-SHA256(secret, "reply:<quoteId>:<role>")>` where role is
 * `c` (customer side: the owner and watchers) or `s` (sales side). The role tells the inbound hook which side is
 * speaking; the HMAC makes the address unguessable, so nobody can post into a quote they were not sent an alert for.
 * Quote ids are cuids (lowercase alphanumeric, no hyphen), so the address splits unambiguously.
 *
 * Dependency-free on purpose: imported by both the worker (sending) and apps/api/src/hooks (receiving).
 */
export type ReplyRole = "c" | "s";

export function replyToken(secret: string, quoteId: string, role: ReplyRole): string {
  const mac = createHmac("sha256", secret).update(`reply:${quoteId}:${role}`).digest("hex").slice(0, 24);
  return `${role}${mac}`;
}

export function replyAddress(opts: { secret: string; domain: string; quoteId: string; role: ReplyRole }): string {
  return `q-${opts.quoteId}-${replyToken(opts.secret, opts.quoteId, opts.role)}@${opts.domain}`;
}

const LOCAL = /^q-([a-z0-9]+)-([cs])([0-9a-f]{24})$/;

/** Returns the quote and role if `address` is a well-formed reply address with a valid token, else null. */
export function parseReplyAddress(address: string, secret: string, domain?: string): { quoteId: string; role: ReplyRole } | null {
  const bare = extractEmail(address);
  if (!bare) return null;
  const at = bare.lastIndexOf("@");
  if (at < 1) return null;
  if (domain && bare.slice(at + 1) !== domain.toLowerCase()) return null;
  const m = LOCAL.exec(bare.slice(0, at));
  if (!m) return null;
  const quoteId = m[1]!;
  const role = m[2] as ReplyRole;
  const expected = Buffer.from(replyToken(secret, quoteId, role));
  const given = Buffer.from(`${role}${m[3]}`);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { quoteId, role };
}

/** "Name <a@b.com>" -> "a@b.com" (lower-cased); returns null if no address is present. */
export function extractEmail(s: string | null | undefined): string | null {
  if (!s) return null;
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(s);
  const raw = angle ? angle[1]! : s.trim();
  return /^[^\s@<>,;]+@[^\s@<>,;]+$/.test(raw) ? raw.toLowerCase() : null;
}
