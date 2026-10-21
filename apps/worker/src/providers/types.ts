export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  /** Free-form label for provider-side filtering, e.g. the template name. */
  tag?: string;
  metadata?: Record<string, string>;
}

export interface SmsMessage {
  to: string; // E.164
  body: string;
}

export interface SendResult {
  /** Provider message id (Postmark MessageID / Twilio MessageSid). Logged for every send. */
  providerId: string;
}

export interface EmailProvider {
  send(msg: EmailMessage): Promise<SendResult>;
}

export interface SmsProvider {
  send(msg: SmsMessage): Promise<SendResult>;
}

/**
 * Thrown by providers. `retryable` = worth trying again later (network, 5xx, 429); otherwise the recipient/address is bad
 * and the send is recorded as FAILED. `code` carries the provider code (Twilio 21610 = recipient replied STOP).
 */
export class ProviderError extends Error {
  override name = "ProviderError";
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code?: string | number,
  ) {
    super(message);
  }
}
