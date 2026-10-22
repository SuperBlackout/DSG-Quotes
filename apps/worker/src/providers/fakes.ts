import { ProviderError, type EmailMessage, type EmailProvider, type SendResult, type SmsMessage, type SmsProvider } from "./types";

/** Test doubles: record every send, hand out predictable ids, optionally fail on demand. */
export class FakeEmailProvider implements EmailProvider {
  readonly sent: (EmailMessage & { providerId: string })[] = [];
  failWith: ProviderError | null = null;
  /** Fail only for this recipient address. */
  failFor = new Map<string, ProviderError>();
  private n = 0;

  async send(msg: EmailMessage): Promise<SendResult> {
    const e = this.failFor.get(msg.to) ?? this.failWith;
    if (e) throw e;
    const providerId = `fake-email-${++this.n}`;
    this.sent.push({ ...msg, providerId });
    return { providerId };
  }
}

export class FakeSmsProvider implements SmsProvider {
  readonly sent: (SmsMessage & { providerId: string })[] = [];
  failWith: ProviderError | null = null;
  failFor = new Map<string, ProviderError>();
  private n = 0;

  async send(msg: SmsMessage): Promise<SendResult> {
    const e = this.failFor.get(msg.to) ?? this.failWith;
    if (e) throw e;
    const providerId = `fake-sms-${++this.n}`;
    this.sent.push({ ...msg, providerId });
    return { providerId };
  }
}

/** Dev-only: prints instead of sending (never selected when NODE_ENV=production). */
export class ConsoleEmailProvider implements EmailProvider {
  private n = 0;
  async send(msg: EmailMessage): Promise<SendResult> {
    console.log(`[dev email] to=${msg.to}${msg.cc?.length ? ` cc=${msg.cc.join(",")}` : ""} reply-to=${msg.replyTo ?? "-"} subject=${msg.subject}\n${msg.text}\n`);
    return { providerId: `console-email-${++this.n}` };
  }
}

export class ConsoleSmsProvider implements SmsProvider {
  private n = 0;
  async send(msg: SmsMessage): Promise<SendResult> {
    console.log(`[dev sms] to=${msg.to} ${msg.body}`);
    return { providerId: `console-sms-${++this.n}` };
  }
}

export { ProviderError };
