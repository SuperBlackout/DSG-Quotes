import { z } from "zod";

/** True only for a real calendar date written YYYY-MM-DD ("2026-02-31" and "2026-13-45" are not). */
export function isCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** zod schema for the contract's `format: date` fields. */
export const calendarDate = z.string().refine(isCalendarDate, "Must be a real calendar date (YYYY-MM-DD)");

/** Date-only string -> Date at 00:00 UTC. Call only after `isCalendarDate`. */
export const dateOnlyToDate = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

const OFFSET = /([+-])(\d{2}):?(\d{2})?$/;

/**
 * zod schema for the contract's `format: date-time` fields: an ISO 8601 instant that JavaScript can actually
 * parse, with a plausible UTC offset (real offsets are -12:00 .. +14:00; "+99:00" used to reach the database as an
 * Invalid Date and produce a 500).
 */
export const isoDateTime = z
  .string()
  .datetime({ offset: true })
  .refine((s) => {
    const m = OFFSET.exec(s);
    if (m && (Number(m[2]) > 14 || Number(m[3] ?? "0") > 59)) return false;
    const t = Date.parse(s);
    if (Number.isNaN(t)) return false;
    const y = new Date(t).getUTCFullYear();
    return y >= 1900 && y <= 9999;
  }, "Must be a valid ISO 8601 date-time with a real UTC offset");
