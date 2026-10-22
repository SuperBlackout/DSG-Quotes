/**
 * Typed client for the staff (`/s`) routes of docs/openapi.yaml. This is the ONLY place the admin app
 * talks to the quotes API. Types come from `shared` (generated from the contract).
 *
 * Auth: every request carries `Authorization: Bearer <Shopify session token>`. In the browser the token
 * comes from App Bridge (`shopify.idToken()`); tests inject a fake.
 */
import type { Schemas, operations } from "shared";

export type StaffQuote = Schemas["StaffQuote"];
export type StaffQuoteSummary = Schemas["StaffQuoteSummary"];
export type StaffQuoteLine = Schemas["StaffQuoteLine"];
export type StaffMessage = Schemas["StaffMessage"];
export type StaffSummary = Schemas["StaffSummary"];
export type DraftRevisionRequest = Schemas["DraftRevisionRequest"];
export type StaffLineInput = Schemas["StaffLineInput"];
export type ApiErrorBody = Schemas["Error"];
export type StaffMe = Schemas["StaffMe"];
export type StaffMember = Schemas["StaffMember"];
export type StaffRole = Schemas["StaffRole"];
export type UpdateStaffRequest = Schemas["UpdateStaffRequest"];
export type Team = Schemas["Team"];
export type TeamInput = Schemas["TeamInput"];
export type RoutingRule = Schemas["RoutingRule"];
export type StaffSettings = Schemas["StaffSettings"];
export type SavedReply = Schemas["SavedReply"];
export type SavedReplyInput = Schemas["SavedReplyInput"];
export type StaffCustomer = Schemas["StaffCustomer"];
export type StaffCustomerLocation = Schemas["StaffCustomerLocation"];
export type Attachment = Schemas["Attachment"];
export type UploadUrl = Schemas["UploadUrl"];
export type UploadUrlRequest = Schemas["UploadUrlRequest"];

export type InboxTab = NonNullable<NonNullable<operations["listStaffQuotes"]["parameters"]["query"]>["tab"]>;

export interface InboxQuery {
  tab?: InboxTab;
  rep?: string;
  team?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}

export interface InboxPage {
  items: StaffQuoteSummary[];
  nextCursor: string | null;
}

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorBody["code"],
    message: string,
    public readonly details?: ApiErrorBody["details"],
  ) {
    super(message);
  }

  /** 422 FLOOR_APPROVAL_REQUIRED: `details.lineIds` lists the offending lines. */
  get floorLineIds(): string[] {
    const ids = this.details?.["lineIds"];
    return this.code === "FLOOR_APPROVAL_REQUIRED" && Array.isArray(ids) ? ids.map(String) : [];
  }
}

export interface ClientOptions {
  /** Defaults to "/api" (the `servers` entry for the embedded admin app). */
  baseUrl?: string;
  getToken: () => Promise<string>;
  fetch?: typeof fetch;
}

export function buildQuery(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function createStaffClient(opts: ClientOptions) {
  const base = (opts.baseUrl ?? "/api").replace(/\/$/, "");
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await opts.getToken();
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      const e = (json ?? {}) as Partial<ApiErrorBody>;
      throw new ApiError(res.status, e.code ?? "INTERNAL", e.message ?? `Request failed (${res.status})`, e.details);
    }
    return json as T;
  }

  const q = (id: string) => `/s/quotes/${encodeURIComponent(id)}`;
  const nr = (id: string, rid: string) => `${q(id)}/notification-recipients/${encodeURIComponent(rid)}`;

  return {
    listQuotes: (query: InboxQuery = {}) => request<InboxPage>("GET", `/s/quotes${buildQuery({ ...query })}`),
    getQuote: (id: string) => request<StaffQuote>("GET", q(id)),
    createQuote: (body: Schemas["StaffCreateQuoteRequest"]) => request<StaffQuote>("POST", "/s/quotes", body),
    claim: (id: string) => request<StaffQuote>("POST", `${q(id)}/claim`),
    assign: (id: string, body: { repId?: string | null; teamId?: string | null }) =>
      request<StaffQuote>("POST", `${q(id)}/assign`, body),
    saveDraft: (id: string, body: DraftRevisionRequest) => request<StaffQuote>("PUT", `${q(id)}/draft-revision`, body),
    send: (id: string) => request<StaffQuote>("POST", `${q(id)}/send`),
    approveFloor: (id: string, body: { lineIds?: string[]; note?: string } = {}) =>
      request<StaffQuote>("POST", `${q(id)}/approve-floor`, body),
    reopen: (id: string) => request<StaffQuote>("POST", `${q(id)}/reopen`),
    decline: (id: string, body: { reason?: string } = {}) => request<StaffQuote>("POST", `${q(id)}/decline`, body),
    getNotifications: (id: string) => request<QuoteNotifications>("GET", `${q(id)}/notifications`),
    addNotificationRecipient: (id: string, body: { kind: "EMAIL" | "SMS"; address: string; name?: string }) =>
      request<QuoteExtraRecipient>("POST", `${q(id)}/notification-recipients`, body),
    resendNotificationOptIn: (id: string, rid: string) => request<QuoteExtraRecipient>("POST", `${nr(id, rid)}/resend`),
    removeNotificationRecipient: (id: string, rid: string) => request<void>("DELETE", nr(id, rid)),
    listMessages: (id: string, cursor?: string) =>
      request<{ items: StaffMessage[]; nextCursor: string | null }>("GET", `${q(id)}/messages${buildQuery({ cursor })}`),
    postMessage: (id: string, body: { body: string; internal?: boolean; attachments?: Attachment[]; channels?: { email: boolean; sms: boolean } }) =>
      request<StaffMessage>("POST", `${q(id)}/messages`, body),
    summary: () => request<StaffSummary>("GET", "/s/reports/summary"),
    /** No status change; notifies managers. Omit `lineIds` to request approval for every flagged line. */
    requestFloorApproval: (id: string, body: { lineIds?: string[]; note?: string } = {}) =>
      request<StaffQuote>("POST", `${q(id)}/request-floor-approval`, body),
    createAttachmentUpload: (id: string, body: UploadUrlRequest) =>
      request<UploadUrl>("POST", `${q(id)}/attachments/upload-url`, body),
    /** Customer search for "create quote on behalf". The server needs at least 2 characters. */
    searchCustomers: (query: string, limit = 10) =>
      request<{ items: StaffCustomer[] }>("GET", `/s/customers${buildQuery({ q: query.trim(), limit })}`),

    me: () => request<StaffMe>("GET", "/s/me"),
    listStaff: (active?: boolean) =>
      request<{ items: StaffMember[] }>("GET", `/s/staff${buildQuery({ active: active === undefined ? undefined : String(active) })}`),
    updateStaff: (id: string, patch: UpdateStaffRequest) =>
      request<StaffMember>("PUT", `/s/staff/${encodeURIComponent(id)}`, patch),
    listTeams: () => request<{ items: Team[] }>("GET", "/s/teams"),
    createTeam: (body: TeamInput) => request<Team>("POST", "/s/teams", body),
    updateTeam: (id: string, body: TeamInput) => request<Team>("PUT", `/s/teams/${encodeURIComponent(id)}`, body),
    deleteTeam: (id: string) => request<void>("DELETE", `/s/teams/${encodeURIComponent(id)}`),
    getSettings: () => request<StaffSettings>("GET", "/s/settings"),
    /** Full replace. Manager or admin only. */
    putSettings: (body: StaffSettings) => request<StaffSettings>("PUT", "/s/settings", body),
    listSavedReplies: () => request<{ items: SavedReply[] }>("GET", "/s/saved-replies"),
    /** Full replace of the caller's replies (and, for managers, the shared ones). */
    putSavedReplies: (items: SavedReplyInput[]) =>
      request<{ items: SavedReply[] }>("PUT", "/s/saved-replies", { items }),
  };
}

export type StaffClient = ReturnType<typeof createStaffClient>;

/** Who gets alerts for one quote (GET /s/quotes/{id}/notifications). */
export interface QuoteExtraRecipient {
  id: string;
  kind: "EMAIL" | "SMS";
  address: string;
  name: string | null;
  status: "ACTIVE" | "PENDING" | "OPTED_OUT";
  addedBy: string | null;
  addedAt: string;
  confirmedAt: string | null;
  requestSent: boolean;
}
export interface QuoteNotifications {
  recipients: { group: "customer" | "team"; who: string; name: string; email: string | null; emailOn: boolean; cc: string | null; phone: string | null; texting: "on" | "off" | "stopped" }[];
  extras: QuoteExtraRecipient[];
  log: { at: string; channel: "EMAIL" | "SMS"; to: string; status: string }[];
}
