/** Normalise a US-centric phone number to E.164. Returns null when it cannot be a mobile number. */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export type SmsKeyword = "STOP" | "HELP" | "START" | null;

const STOP = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPTOUT"]);
const START = new Set(["START", "YES", "UNSTOP"]);
const HELP = new Set(["HELP", "INFO"]);

/** Carrier-standard keywords: the whole message (ignoring case/punctuation) must be the keyword. */
export function smsKeyword(body: string | null | undefined): SmsKeyword {
  const w = (body ?? "").trim().toUpperCase().replace(/[^A-Z]/g, "");
  if (STOP.has(w)) return "STOP";
  if (HELP.has(w)) return "HELP";
  if (START.has(w)) return "START";
  return null;
}
