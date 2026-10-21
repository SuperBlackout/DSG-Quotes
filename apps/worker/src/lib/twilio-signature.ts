import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Twilio request signature: base64(HMAC-SHA1(authToken, fullUrl + for each POST param sorted by name: name + value)).
 * https://www.twilio.com/docs/usage/security#validating-requests (re-implemented here so the code is testable
 * without the Twilio SDK; verified against the algorithm in that document, NOT against live Twilio traffic).
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string | string[]>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => {
      const v = params[k]!;
      return acc + k + (Array.isArray(v) ? [...v].sort().join("") : v);
    }, url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string | string[]>, header: string | undefined): boolean {
  if (!header) return false;
  const a = Buffer.from(twilioSignature(authToken, url, params));
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}
