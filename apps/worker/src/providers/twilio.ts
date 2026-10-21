import { ProviderError, type SendResult, type SmsMessage, type SmsProvider } from "./types";

type Fetch = typeof fetch;

/** Twilio error code returned when the recipient has replied STOP to the Messaging Service. */
export const TWILIO_UNSUBSCRIBED = 21610;

/**
 * Twilio Programmable Messaging via a Messaging Service (A2P 10DLC). Written from the public REST docs and exercised only
 * against a fake `fetch`: NOT verified against live Twilio (no credentials, and A2P approval is pending).
 */
export class TwilioSmsProvider implements SmsProvider {
  constructor(
    private readonly cfg: { accountSid: string; authToken: string; messagingServiceSid: string },
    private readonly opts: { baseUrl?: string; fetch?: Fetch } = {},
  ) {}

  async send(msg: SmsMessage): Promise<SendResult> {
    const f = this.opts.fetch ?? fetch;
    const url = `${this.opts.baseUrl ?? "https://api.twilio.com"}/2010-04-01/Accounts/${encodeURIComponent(this.cfg.accountSid)}/Messages.json`;
    let res: Response;
    try {
      res = await f(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: msg.to, MessagingServiceSid: this.cfg.messagingServiceSid, Body: msg.body }).toString(),
      });
    } catch (e) {
      throw new ProviderError(`Twilio request failed: ${(e as Error).message}`, true);
    }
    const body = (await res.json().catch(() => ({}))) as { sid?: string; code?: number; message?: string };
    if (res.ok && body.sid) return { providerId: body.sid };
    throw new ProviderError(`Twilio ${res.status} (${body.code ?? "?"}): ${body.message ?? "unknown error"}`, res.status >= 500 || res.status === 429, body.code);
  }
}
