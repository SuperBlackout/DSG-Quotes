// Typed client for the customer (/c) routes of docs/openapi.yaml.
// Runs inside the customer-account extension Web Worker: auth is a fresh Shopify session token per
// request (`shopify.sessionToken.get()`), sent as `Authorization: Bearer`.
import type {
  Attachment,
  CheckoutResult,
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

  async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      const token = await opts.getToken();
      const headers: Record<string, string> = {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiError(0, "NETWORK", err instanceof Error ? err.message : "Network request failed");
    }

    const text = await res.text();
    let json: unknown;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }

    if (!res.ok) {
      const e = (json ?? {}) as Partial<{ code: string; message: string; details: Record<string, unknown> }>;
      throw new ApiError(
        res.status,
        e.code ?? (res.status === 401 ? "UNAUTHENTICATED" : "INTERNAL"),
        e.message ?? `Request failed (${res.status})`,
        e.details,
      );
    }
    return assertCustomerSafe(json as T);
  }

  const q = (id: string) => `/c/quotes/${encodeURIComponent(id)}`;

  return {
    listQuotes: (p: ListQuotesParams = {}) =>
      request<Page<CustomerQuoteSummary>>("GET", `/c/quotes${toQuery({ ...p })}`),

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
