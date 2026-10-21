/** Quiet hours: a daily local-time window, possibly wrapping midnight (e.g. 19:00 -> 07:00). */
export const DEFAULT_TZ = "America/New_York";

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function toMinutes(hhmm: string | null | undefined): number | null {
  const m = hhmm ? HHMM.exec(hhmm) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function safeTz(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

/** Minutes since local midnight in `tz`. */
export function localMinutes(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: safeTz(tz), hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === "hour")!.value) % 24;
  const m = Number(parts.find((p) => p.type === "minute")!.value);
  return h * 60 + m;
}

/** Local calendar parts in `tz` (used by the 8:00 ET cron gate and its once-a-day marker). */
export function localParts(at: Date, tz: string): { date: string; hour: number; minute: number; weekday: number } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: safeTz(tz), hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: safeTz(tz), weekday: "short" }).format(at);
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd) };
}

export interface QuietWindow {
  start: string | null;
  end: string | null;
  tz: string | null;
}

export function inQuietHours(at: Date, w: QuietWindow): boolean {
  const s = toMinutes(w.start);
  const e = toMinutes(w.end);
  if (s === null || e === null || s === e) return false;
  const m = localMinutes(at, w.tz ?? DEFAULT_TZ);
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/** The first instant at or after `at` when the quiet window ends (local `end` time). Only meaningful when inQuietHours. */
export function quietEndsAt(at: Date, w: QuietWindow): Date {
  const e = toMinutes(w.end);
  if (e === null) return at;
  const tz = w.tz ?? DEFAULT_TZ;
  const base = Math.floor(at.getTime() / 60000) * 60000;
  const delta = (e - localMinutes(at, tz) + 1440) % 1440;
  let candidate = base + delta * 60000;
  // Correct for a DST change between now and the end of the window.
  for (let i = 0; i < 3; i++) {
    const diff = ((e - localMinutes(new Date(candidate), tz) + 1440 + 720) % 1440) - 720;
    if (diff === 0) break;
    candidate += diff * 60000;
  }
  return new Date(candidate);
}
