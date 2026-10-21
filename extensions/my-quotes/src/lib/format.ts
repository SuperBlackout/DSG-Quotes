// Money and date helpers. Money arrives as decimal strings ("1234.50"); all arithmetic is done in
// integer cents so totals never pick up float noise.
import type { Money } from "../api/types";

const MONEY_RE = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

/** "1234.50" -> 123450. Throws on anything that is not a plain decimal string. */
export function toCents(m: Money): number {
  const match = MONEY_RE.exec(m.trim());
  if (!match) throw new Error(`Invalid money value: ${JSON.stringify(m)}`);
  const [, sign, whole, frac = ""] = match;
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return sign ? -cents : cents;
}

export function fromCents(cents: number): Money {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/**
 * "1234.5" -> "$1,234.50". The contract's Money type carries no currency code, so USD is assumed
 * (DSG sells in USD only). If multi-currency ever matters, Money needs a currency field.
 */
export function formatMoney(m: Money | null | undefined): string {
  if (m === null || m === undefined || m === "") return "";
  return USD.format(toCents(m) / 100);
}

export function formatCents(cents: number): string {
  return USD.format(cents / 100);
}

export function sumCents(values: Money[]): number {
  return values.reduce((acc, v) => acc + toCents(v), 0);
}

/** "Oct 18" (same year) or "Oct 18, 2025". `timeZone` is for tests; defaults to the viewer's zone. */
export function formatShortDate(iso: string, now: Date = new Date(), timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(d) ===
    new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(now);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone,
  }).format(d);
}

/** "Nov 4, 2026" */
export function formatLongDate(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone }).format(d);
}

/** "Oct 18, 3:04 PM" */
export function formatDateTime(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(d);
}

/** "2 hours ago", "yesterday", then a short date after a week. */
export function formatRelative(iso: string, now: Date = new Date(), timeZone?: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.floor((now.getTime() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return formatShortDate(iso, now, timeZone);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
