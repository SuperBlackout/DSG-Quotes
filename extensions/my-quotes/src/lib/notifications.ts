// Screen 5 form model: event x channel matrix, contact fields, SMS opt-in, quiet hours, watchers.
import type { NotificationChannelPref, NotificationEvent, NotificationPrefs, Watcher } from "../api/types";
import { consentPayload } from "./consent";

export interface EventDef {
  /** Key inside NotificationPrefs.events. */
  key: NotificationEvent;
  /** Friendly label (CA-5). */
  title: string;
  description: string;
  /** false = email only (the Text cell shows a dash). */
  sms: boolean;
}

/**
 * Exactly the seven customer-facing keys of the contract's `NotificationEvent` (CHANGES_REQUESTED is
 * staff-only and not a preference). `satisfies` plus the Record type below make the compiler fail if
 * the contract adds or removes a key.
 */
export const EVENT_DEFS = [
  { key: "QUOTE_RECEIVED", title: "Quote received", description: "Confirmation after you submit a quote", sms: true },
  { key: "QUOTE_READY", title: "Quote ready", description: "Sales sent new or revised pricing to review", sms: true },
  {
    key: "NEW_MESSAGE",
    title: "New message",
    description: "A message or question from sales. Messages within 5 minutes are bundled into one alert",
    sms: true,
  },
  { key: "EXPIRING", title: "Expiring soon", description: "Reminder 3 days before held prices lapse", sms: true },
  { key: "ORDERED", title: "Ordered", description: "Order confirmation after you buy from a quote", sms: true },
  { key: "ACCEPTED", title: "Accepted", description: "Confirmation when a quote is accepted", sms: true },
  { key: "WEEKLY_SUMMARY", title: "Weekly summary", description: "Open quotes digest, Mondays 8:00 AM", sms: false },
] as const satisfies readonly EventDef[];

export const EVENT_KEYS: readonly NotificationEvent[] = EVENT_DEFS.map((d) => d.key);

export const DEFAULT_QUIET_START = "19:00";
export const DEFAULT_QUIET_END = "07:00";

/** Watcher scope meaning "every quote" (contract `WatcherScope`); anything else is a job id. */
export const SCOPE_ALL = "all";

/** A watcher as edited in the UI: text fields are plain strings; empty name/role are omitted on save. */
export interface WatcherForm {
  email: string;
  name: string;
  role: string;
  /** "all" or a JobRef.id */
  scope: string;
  channels: NotificationChannelPref;
}

export function emptyWatcher(): WatcherForm {
  return { email: "", name: "", role: "", scope: SCOPE_ALL, channels: { email: true, sms: false } };
}

export interface PrefsForm {
  events: Record<NotificationEvent, NotificationChannelPref>;
  email: string;
  /** As typed by the customer. Normalized to E.164 on save. */
  phone: string;
  smsOptIn: boolean;
  quietEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  timezone: string;
  watchers: WatcherForm[];
}

export function watcherToForm(w: Watcher): WatcherForm {
  return {
    email: w.email,
    name: w.name ?? "",
    role: w.role ?? "",
    scope: w.scope || SCOPE_ALL,
    channels: { email: w.channels?.email ?? false, sms: w.channels?.sms ?? false },
  };
}

export function formFromPrefs(p: NotificationPrefs, fallbackTimezone = "America/New_York"): PrefsForm {
  const events = {} as Record<NotificationEvent, NotificationChannelPref>;
  for (const def of EVENT_DEFS) {
    const cur = (p.events as Partial<Record<NotificationEvent, NotificationChannelPref>> | undefined)?.[def.key];
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
    watchers: (p.watchers ?? []).map(watcherToForm),
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

/** Dedupe key: the same person may follow different jobs, but not the same scope twice. */
export function watcherKey(w: Pick<WatcherForm, "email" | "scope">): string {
  return `${w.email.trim().toLowerCase()}|${w.scope}`;
}

/** Error text for one watcher row, or undefined when it can be saved. */
export function watcherError(w: WatcherForm): string | undefined {
  if (!isEmail(w.email)) return `"${w.email}" is not a valid email address.`;
  if (!w.channels.email && !w.channels.sms) return `Pick email or text for ${w.email}.`;
  return undefined;
}

export function validatePrefs(f: PrefsForm): PrefsErrors {
  const errors: PrefsErrors = {};
  if (!isEmail(f.email)) errors.email = "Enter a valid email address.";

  const wantsSms = f.smsOptIn || anySmsEnabled(f);
  if (wantsSms && normalizePhone(f.phone) === null) errors.phone = "Enter a valid mobile number to get texts.";
  if (anySmsEnabled(f) && !f.smsOptIn) errors.smsOptIn = "Agree to the text message terms to turn on texts.";

  const seen = new Set<string>();
  for (const w of f.watchers) {
    const err = watcherError(w);
    if (err) {
      errors.watchers = err;
      continue;
    }
    const key = watcherKey(w);
    if (seen.has(key)) errors.watchers = `${w.email} is listed twice for the same scope.`;
    seen.add(key);
  }
  return errors;
}

// ---- save payload --------------------------------------------------------------------------------

export function watcherToPut(w: WatcherForm): Watcher {
  const out: Watcher = {
    email: w.email.trim(),
    scope: w.scope || SCOPE_ALL,
    channels: { email: w.channels.email, sms: w.channels.sms },
  };
  const name = w.name.trim();
  const role = w.role.trim();
  if (name) out.name = name;
  if (role) out.role = role;
  return out;
}

/**
 * Body for PUT /c/notification-prefs (a full replace). All seven event keys are sent, nothing else
 * (unknown keys are rejected server-side). `smsOptInAt` is read-only server-side and never sent.
 */
export function prefsToPut(_original: NotificationPrefs, f: PrefsForm): NotificationPrefs {
  const phone = normalizePhone(f.phone);
  const events = {} as NotificationPrefs["events"];
  for (const key of EVENT_KEYS) events[key] = { email: f.events[key].email, sms: f.events[key].sms };
  return {
    events,
    email: f.email.trim(),
    phone,
    ...consentPayload(f.smsOptIn),
    quietStart: f.quietEnabled ? f.quietStart : null,
    quietEnd: f.quietEnabled ? f.quietEnd : null,
    timezone: f.timezone,
    watchers: f.watchers.map(watcherToPut),
  };
}

// ---- watcher scope choices ---------------------------------------------------------------------------

export interface ScopeOption {
  value: string;
  label: string;
}

/**
 * "All quotes" plus one entry per known job. A watcher whose job is not in `jobs` (for example it was
 * loaded from the server but the job list failed to load) is kept as "A specific job" so a save never
 * rewrites its scope.
 */
export function scopeOptions(jobs: ReadonlyArray<{ id: string; name: string }>, watchers: readonly WatcherForm[]): ScopeOption[] {
  const out: ScopeOption[] = [{ value: SCOPE_ALL, label: "All quotes" }];
  const known = new Set<string>();
  for (const j of jobs) {
    if (known.has(j.id)) continue;
    known.add(j.id);
    out.push({ value: j.id, label: `Job: ${j.name}` });
  }
  for (const w of watchers) {
    if (w.scope !== SCOPE_ALL && !known.has(w.scope)) {
      known.add(w.scope);
      out.push({ value: w.scope, label: "A specific job" });
    }
  }
  return out;
}

/** One-line description of a watcher: "Sam Lee · Project manager · All quotes · Email + text". */
export function describeWatcher(w: WatcherForm, scopes: readonly ScopeOption[]): string {
  const channels = [w.channels.email ? "Email" : "", w.channels.sms ? "Text" : ""].filter(Boolean).join(" + ");
  const scope = scopes.find((s) => s.value === w.scope)?.label ?? "A specific job";
  return [w.name.trim(), w.role.trim(), scope, channels].filter(Boolean).join(" · ");
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
