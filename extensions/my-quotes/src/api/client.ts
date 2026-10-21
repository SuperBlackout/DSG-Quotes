// Typed client for the customer (/c) routes of docs/openapi.yaml.
// Runs inside the customer-account extension Web Worker: auth is a fresh Shopify session token per
// request (`shopify.sessionToken.get()`), sent as `Authorization: Bearer`.
import type {
  Attachment,
  CheckoutResult,
  CreateQuoteRequest,
  CustomerMessage,
  CustomerQuote,
  CustomerQuoteSummary,
  ListQuotesParams,
  NotificationPrefs,
  Page,
  PostMessageRequest,
  UpdateQuoteRequest,
  UploadUrl,
} from "./types";

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface PdfFile {
  blob: Blob;
  /** From Content-Disposition, e.g. "Q-10482-v2.pdf". */
  filename: string;
}

export interface ApiClientOptions {
  /** Origin that serves /c/*, no trailing slash. */
  baseUrl: string;
  /** Return a fresh session token. Called before every request (tokens live 5 minutes). */
  getToken: () => Promise<string>;
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/**
 * Keys that exist only on staff shapes. The customer schemas never contain them (contract test in
 * packages/shared), so seeing one in a response means the backend leaked: refuse to render it.
 */
export const STAFF_ONLY_KEYS: ReadonlySet<string> = new Set([
  "cost",
  "unitCost",
  "lineCost",
  "marginPct",
  "margin",
  "internalNote",
  "internal",
]);

/** Throws if `value` contains a staff-only key at any depth. Returns the value unchanged. */
export function assertCustomerSafe<T>(value: T): T {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item);
    } else if (cur !== null && typeof cur === "object") {
      for (const [key, child] of Object.entries(cur)) {
        if (STAFF_ONLY_KEYS.has(key)) {
          throw new ApiError(502, "CONTRACT_VIOLATION", `Response contained a staff-only field "${key}"`);
        }
        stack.push(child);
      }
    }
  }
  return value;
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

function toQuery(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

export function createApiClient(opts: ApiClientOptions) {
  const doFetch: typeof fetch = opts.fetch ?? ((...a) => fetch(...a));
  const base = opts.baseUrl.replace(/\/+$/, "");

  /**
   * One authenticated call. Any failure to get a response (offline, DNS, or a CORS rejection, which
   * browsers surface as a bare TypeError because the extension runs with a null origin) becomes
   * ApiError code NETWORK so the UI can show a retry state (CA-10).
   */
  async function send(method: Method, path: string, accept: string, body?: unknown): Promise<Response> {
    try {
      const token = await opts.getToken();
      const headers: Record<string, string> = {
        Accept: accept,
        Authorization: `Bearer ${token}`,
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      return await doFetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiError(0, "NETWORK", err instanceof Error ? err.message : "Network request failed");
    }
  }

  /** Turns a non-2xx response into the ApiError the API's `{code,message,details}` body describes. */
  async function toApiError(res: Response): Promise<ApiError> {
    let json: unknown;
    try {
      const text = await res.text();
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    const e = (json ?? {}) as Partial<{ code: string; message: string; details: Record<string, unknown> }>;
    return new ApiError(
      res.status,
      e.code ?? (res.status === 401 ? "UNAUTHENTICATED" : "INTERNAL"),
      e.message ?? `Request failed (${res.status})`,
      e.details,
    );
  }

  async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const res = await send(method, path, "application/json", body);

    if (!res.ok) throw await toApiError(res);

    const text = await res.text();
    let json: unknown;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return assertCustomerSafe(json as T);
  }

  /** GET /c/quotes/{id}/pdf. The Authorization header is why this is a fetch and not a plain link. */
  async function requestPdf(id: string, version?: number): Promise<PdfFile> {
    const qs = version === undefined ? "" : `?version=${encodeURIComponent(String(version))}`;
    const res = await send("GET", `${q(id)}/pdf${qs}`, "application/pdf");
    if (!res.ok) throw await toApiError(res);
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") ?? "";
    const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
    return { blob, filename: named ? decodeURIComponent(named) : "quote.pdf" };
  }

  const q = (id: string) => `/c/quotes/${encodeURIComponent(id)}`;

  return {
    listQuotes: (p: ListQuotesParams = {}) =>
      request<Page<CustomerQuoteSummary>>("GET", `/c/quotes${toQuery({ ...p })}`),

    createQuote: (body: CreateQuoteRequest) => request<CustomerQuote>("POST", "/c/quotes", body),
    getQuote: (id: string) => request<CustomerQuote>("GET", q(id)),
    updateQuote: (id: string, patch: UpdateQuoteRequest) => request<CustomerQuote>("PATCH", q(id), patch),
    deleteQuote: (id: string) => request<unknown>("DELETE", q(id)),

    submitQuote: (id: string, body: { notesToSales?: string; neededBy?: string; poNumber?: string } = {}) =>
      request<CustomerQuote>("POST", `${q(id)}/submit`, body),
    withdrawQuote: (id: string) => request<CustomerQuote>("POST", `${q(id)}/withdraw`),
    /** `versionNo` is the version the customer saw; the API answers 409 VERSION_MISMATCH if stale. */
    acceptQuote: (id: string, versionNo?: number) =>
      request<CustomerQuote>("POST", `${q(id)}/accept`, versionNo === undefined ? {} : { versionNo }),
    requestChanges: (id: string, message: string) =>
      request<CustomerQuote>("POST", `${q(id)}/request-changes`, { message }),
    declineQuote: (id: string, reason?: string) =>
      request<CustomerQuote>("POST", `${q(id)}/decline`, reason ? { reason } : {}),
    reopenQuote: (id: string) => request<CustomerQuote>("POST", `${q(id)}/reopen`),
    duplicateQuote: (id: string) => request<CustomerQuote>("POST", `${q(id)}/duplicate`),
    /** Customer-safe PDF of the latest sent version (or `version`). 404 NOT_FOUND until one is sent. */
    downloadPdf: (id: string, version?: number) => requestPdf(id, version),
    /** Idempotent. 409 NOT_PURCHASABLE when the quote is not ACCEPTED or has expired. */
    checkout: (id: string) => request<CheckoutResult>("POST", `${q(id)}/checkout`),

    listMessages: (id: string, p: { cursor?: string; limit?: number } = {}) =>
      request<Page<CustomerMessage>>("GET", `${q(id)}/messages${toQuery({ ...p })}`),
    postMessage: (id: string, msg: PostMessageRequest) =>
      request<CustomerMessage>("POST", `${q(id)}/messages`, msg),

    createUpload: (id: string, file: { name: string; size: number; mime: string }) =>
      request<UploadUrl>("POST", `${q(id)}/attachments/upload-url`, file),

    /**
     * Signed upload then PUT the bytes straight to storage (no Authorization header: the URL is
     * pre-signed). Returns the Attachment to pass to postMessage.
     */
    async uploadAttachment(id: string, file: { name: string; size: number; type: string } & Blob): Promise<Attachment> {
      const mime = file.type || "application/octet-stream";
      const target = await request<UploadUrl>("POST", `${q(id)}/attachments/upload-url`, {
        name: file.name,
        size: file.size,
        mime,
      });
      let put: Response;
      try {
        put = await doFetch(target.uploadUrl, { method: "PUT", headers: { "Content-Type": mime }, body: file });
      } catch (err) {
        throw new ApiError(0, "NETWORK", err instanceof Error ? err.message : "Upload failed");
      }
      if (!put.ok) throw new ApiError(put.status, "UPLOAD_FAILED", `Upload failed (${put.status})`);
      return { url: target.fileUrl, name: file.name, size: file.size, mime };
    },

    getNotificationPrefs: () => request<NotificationPrefs>("GET", "/c/notification-prefs"),
    putNotificationPrefs: (prefs: NotificationPrefs) =>
      request<NotificationPrefs>("PUT", "/c/notification-prefs", prefs),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
