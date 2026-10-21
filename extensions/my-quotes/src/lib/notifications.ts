// Screen 5 form model: event x channel matrix, contact fields, SMS opt-in, quiet hours, watchers.
import type { NotificationChannelPref, NotificationPrefs } from "../api/types";
import { consentPayload } from "./consent";

export interface EventDef {
  /** Key inside NotificationPrefs.events. */
  key: string;
  title: string;
  description: string;
  /** false = email only (the Text cell shows a dash). */
  sms: boolean;
}

/**
 * Rows of the matrix, in mockup order. The contract only lists example keys (QUOTE_READY,
 * NEW_MESSAGE, ACCEPTED, ORDERED, EXPIRING, CHANGES_REQUESTED); QUOTE_RECEIVED and WEEKLY_SUMMARY are
 * assumed names for the mockup rows "Quote received by sales" and "Weekly summary of open quotes".
 * The lead must confirm the full key set with the notifications agent.
 */
export const EVENT_DEFS: readonly EventDef[] = [
  { key: "QUOTE_READY", title: "Quote is ready or revised", description: "Sales sent new pricing to review", sms: true },
  {
    key: "NEW_MESSAGE",
    title: "New message or question from sales",
    description: "Messages within 5 minutes are bundled into one alert",
    sms: true,
  },
  { key: "QUOTE_RECEIVED", title: "Quote received by sales", description: "Confirmation after you submit", sms: true },
  { key: "EXPIRING", title: "Quote expiring in 3 days", description: "Reminder before held prices lapse", sms: true },
  { key: "ORDERED", title: "Order placed from a quote", description: "Order confirmation and tracking", sms: true },
  { key: "WEEKLY_SUMMARY", title: "Weekly summary of open quotes", description: "Mondays, 8:00 AM", sms: false },
];

export const DEFAULT_QUIET_START = "19:00";
export const DEFAULT_QUIET_END = "07:00";

export interface PrefsForm {
  events: Record<string, NotificationChannelPref>;
  email: string;
  /** As typed by the customer. Normalized to E.164 on save. */
  phone: string;
  smsOptIn: boolean;
  quietEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  timezone: string;
  watchers: string[];
}

export function formFromPrefs(p: NotificationPrefs, fallbackTimezone = "America/New_York"): PrefsForm {
  const events: Record<string, NotificationChannelPref> = {};
  for (const def of EVENT_DEFS) {
    const cur = p.events[def.key];
    events[def.key] = { email: cur?.email ?? false, sms: def.sms ? (cur?.sms ?? false) : false };
  }
  const quietEnabled = !!p.quietStart && !!p.quietEnd;
  return {
    events,
    email: p.email,
    phone: p.phone ? formatPhone(p.phone) : "",
    smsOptIn: p.smsOptIn ?? false,
    quietEnabled,
    quietStart: p.quietStart || DEFAULT_QUIET_START,
    quietEnd: p.quietEnd || DEFAULT_QUIET_END,
    timezone: p.timezone || fallbackTimezone,
    watchers: [...(p.watchers ?? [])],
  };
}

// ---- phone -------------------------------------------------------------------------------------

/**
 * US-first normalization to E.164. "(516) 555-0142" -> "+15165550142". Accepts an explicit "+" with
 * 8-15 digits for non-US numbers. Returns null when it cannot be a mobile number.
 */
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** "+15165550142" -> "(516) 555-0142"; other numbers are returned as stored. */
export function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (s: string): boolean => EMAIL_RE.test(s.trim());

// ---- validation ----------------------------------------------------------------------------------

export type PrefsErrors = Partial<Record<"email" | "phone" | "smsOptIn" | "watchers", string>>;

export function anySmsEnabled(f: PrefsForm): boolean {
  return EVENT_DEFS.some((d) => d.sms && f.events[d.key]?.sms);
}

export function validatePrefs(f: PrefsForm): PrefsErrors {
  const errors: PrefsErrors = {};
  if (!isEmail(f.email)) errors.email = "Enter a valid email address.";

  const wantsSms = f.smsOptIn || anySmsEnabled(f);
  if (wantsSms && normalizePhone(f.phone) === null) errors.phone = "Enter a valid mobile number to get texts.";
  if (anySmsEnabled(f) && !f.smsOptIn) errors.smsOptIn = "Agree to the text message terms to turn on texts.";

  const seen = new Set<string>();
  for (const w of f.watchers) {
    const key = w.trim().toLowerCase();
    if (!isEmail(w)) errors.watchers = `"${w}" is not a valid email address.`;
    else if (seen.has(key)) errors.watchers = `${w} is listed twice.`;
    seen.add(key);
  }
  return errors;
}

// ---- save payload --------------------------------------------------------------------------------

/**
 * Body for PUT /c/notification-prefs (a full replace). Unknown event keys returned by the server are
 * carried over untouched so saving this page never silently turns off e.g. ACCEPTED alerts.
 * `smsOptInAt` is read-only server-side and is never sent.
 */
export function prefsToPut(original: NotificationPrefs, f: PrefsForm): NotificationPrefs {
  const phone = normalizePhone(f.phone);
  const body: NotificationPrefs = {
    events: { ...original.events, ...f.events },
    email: f.email.trim(),
    phone,
    ...consentPayload(f.smsOptIn),
    quietStart: f.quietEnabled ? f.quietStart : null,
    quietEnd: f.quietEnabled ? f.quietEnd : null,
    timezone: f.timezone,
    watchers: f.watchers.map((w) => w.trim()),
  };
  return body;
}

// ---- quiet-hours choices ---------------------------------------------------------------------------

/** Every half hour: { value: "19:00", label: "7:00 PM" }. */
export function timeOptions(): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30]) {
      const value = `${String(h).padStart(2, "0")}:${m === 0 ? "00" : "30"}`;
      out.push({ value, label: formatTime(value) });
    }
  }
  return out;
}

/** "19:00" -> "7:00 PM" */
export function formatTime(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  const suffix = h >= 12 ? "PM" : "AM";
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${suffix}`;
}
