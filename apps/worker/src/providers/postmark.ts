import { ProviderError, type EmailMessage, type EmailProvider, type SendResult } from "./types";

type Fetch = typeof fetch;

/**
 * Postmark outbound (https://postmarkapp.com/developer/api/email-api). Written from the public API docs and exercised only
 * against a fake `fetch` in tests: NOT verified against a live Postmark server (no credentials exist yet).
 */
export class PostmarkEmailProvider implements EmailProvider {
  constructor(
    private readonly serverToken: string,
    private readonly opts: { messageStream?: string; baseUrl?: string; fetch?: Fetch } = {},
  ) {}

  async send(msg: EmailMessage): Promise<SendResult> {
    const f = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(`${this.opts.baseUrl ?? "https://api.postmarkapp.com"}/email`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": this.serverToken,
        },
        body: JSON.stringify({
          From: msg.from,
          To: msg.to,
          ...(msg.cc?.length ? { Cc: msg.cc.join(", ") } : {}),
          Subject: msg.subject,
          TextBody: msg.text,
          HtmlBody: msg.html,
          ...(msg.replyTo ? { ReplyTo: msg.replyTo } : {}),
          ...(msg.tag ? { Tag: msg.tag } : {}),
          ...(msg.metadata ? { Metadata: msg.metadata } : {}),
          MessageStream: this.opts.messageStream ?? "outbound",
        }),
      });
    } catch (e) {
      throw new ProviderError(`Postmark request failed: ${(e as Error).message}`, true);
    }
    const body = (await res.json().catch(() => ({}))) as { ErrorCode?: number; Message?: string; MessageID?: string };
    if (res.ok && body.ErrorCode === 0 && body.MessageID) return { providerId: body.MessageID };
    // 406 = inactive recipient (bounced/spam complaint), 300 = invalid email: retrying cannot help.
    const retryable = res.status >= 500 || res.status === 429;
    throw new ProviderError(`Postmark ${res.status} (${body.ErrorCode ?? "?"}): ${body.Message ?? "unknown error"}`, retryable, body.ErrorCode);
  }
}
