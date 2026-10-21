import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Config } from "./config";

export interface SignedUpload {
  uploadUrl: string;
  fileUrl: string;
  expiresAt: Date;
}

export interface AttachmentSigner {
  createUpload(input: { quoteId: string; name: string; mime: string; size: number; now: Date }): SignedUpload;
  /** True when `url` points at our own bucket (so a client cannot attach arbitrary URLs). */
  isOwnUrl(url: string): boolean;
}

const sanitize = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "file";

/** Deterministic fake for tests and local dev (no bucket needed). */
export class FakeAttachmentSigner implements AttachmentSigner {
  createUpload(input: { quoteId: string; name: string; now: Date }): SignedUpload {
    const key = `quotes/${input.quoteId}/${randomUUID()}-${sanitize(input.name)}`;
    return {
      uploadUrl: `https://uploads.fake.test/${key}?sig=fake`,
      fileUrl: `https://files.fake.test/${key}`,
      expiresAt: new Date(input.now.getTime() + 15 * 60_000),
    };
  }
  isOwnUrl(url: string) {
    return url.startsWith("https://files.fake.test/");
  }
}

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");
const hmac = (key: Buffer | string, s: string) => createHmac("sha256", key).update(s).digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * S3-compatible presigned PUT (AWS SigV4, query-string auth, path-style). UNVERIFIED against a real
 * bucket or provider; unit tests only check structure and determinism.
 */
export class S3AttachmentSigner implements AttachmentSigner {
  constructor(private readonly cfg: NonNullable<Config["attachments"]>) {}

  createUpload(input: { quoteId: string; name: string; mime: string; size: number; now: Date }): SignedUpload {
    const key = `quotes/${input.quoteId}/${randomUUID()}-${sanitize(input.name)}`;
    const expiresSeconds = 15 * 60;
    const url = presignPut({
      endpoint: this.cfg.endpoint,
      bucket: this.cfg.bucket,
      key,
      region: this.cfg.region,
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
      expiresSeconds,
      now: input.now,
    });
    return {
      uploadUrl: url,
      fileUrl: `${this.cfg.publicBaseUrl.replace(/\/$/, "")}/${key}`,
      expiresAt: new Date(input.now.getTime() + expiresSeconds * 1000),
    };
  }

  isOwnUrl(url: string) {
    return url.startsWith(this.cfg.publicBaseUrl.replace(/\/$/, "") + "/");
  }
}

export function presignPut(o: {
  endpoint: string;
  bucket: string;
  key: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresSeconds: number;
  now: Date;
}): string {
  const u = new URL(o.endpoint);
  const amzDate = o.now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20130524T000000Z
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${o.region}/s3/aws4_request`;
  const path = `${u.pathname.replace(/\/$/, "")}/${o.bucket}/${o.key.split("/").map(enc).join("/")}`;
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${o.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(o.expiresSeconds),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${enc(k)}=${enc(query[k]!)}`)
    .join("&");
  const canonicalRequest = ["PUT", path, canonicalQuery, `host:${u.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const kDate = hmac("AWS4" + o.secretAccessKey, date);
  const kRegion = hmac(kDate, o.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  return `${u.protocol}//${u.host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
