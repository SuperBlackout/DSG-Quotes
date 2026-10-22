import {
  AccountInfo,
  StatementSummary,
  ActivityPage,
  PdfLink,
  type DocKind,
} from '@dsg/contracts';
import { ACCOUNT_API_PREFIX, resolveBaseUrl } from './config.ts';

export type ApiErrorKind = 'not_linked' | 'unavailable' | 'unauthorized' | 'bad_request' | 'rate_limited' | 'bad_response' | 'network' | 'unknown';

export class ApiError extends Error {
  constructor(public kind: ApiErrorKind, public status: number | null, message: string) {
    super(message);
  }
}

export interface ApiDeps {
  getToken: () => Promise<string>;
  fetch?: typeof fetch;
  baseUrl?: string;
}

export interface ActivityQuery {
  type?: DocKind | '';
  from?: string;
  to?: string;
  cursor?: string | null;
  search?: string;
  limit?: number;
}

export function mapStatus(status: number): ApiError {
  if (status === 403) return new ApiError('not_linked', 403, 'Your account is not linked to a billing customer.');
  if (status === 401) return new ApiError('unauthorized', 401, 'Your session expired. Please reload the page.');
  if (status === 400) return new ApiError('bad_request', 400, 'That request was not valid. Check your date range (From must not be after To) and try again.');
  if (status === 429) return new ApiError('rate_limited', 429, 'Too many requests. Please wait a minute and try again.');
  if (status === 503) return new ApiError('unavailable', 503, 'This page is temporarily unavailable. Please try again shortly.');
  return new ApiError('unknown', status, `Unexpected error (${status}).`);
}

export function buildActivityPath(q: ActivityQuery): string {
  const p = new URLSearchParams();
  if (q.type) p.set('type', q.type);
  if (q.from) p.set('from', q.from);
  if (q.to) p.set('to', q.to);
  if (q.search && q.search.trim()) p.set('search', q.search.trim());
  if (q.cursor) p.set('cursor', q.cursor);
  if (q.limit) p.set('limit', String(q.limit));
  const s = p.toString();
  return `${ACCOUNT_API_PREFIX}/v1/statement/activity${s ? `?${s}` : ''}`;
}

export function createApi(deps: ApiDeps) {
  const base = (deps.baseUrl ?? resolveBaseUrl()).replace(/\/+$/, '');
  const P = ACCOUNT_API_PREFIX;

  async function call<T>(path: string, schema: { parse(v: unknown): T }, init: { method?: string; body?: unknown } = {}): Promise<T> {
    // Fresh token for every request; tokens are short-lived.
    const token = await deps.getToken();
    const f = deps.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(`${base}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch {
      throw new ApiError('network', null, 'Could not reach the account service.');
    }
    if (!res.ok) throw mapStatus(res.status);
    try {
      return schema.parse(await res.json());
    } catch {
      throw new ApiError('bad_response', res.status, 'Received an unexpected response from the account service.');
    }
  }

  return {
    summary: () => call(`${P}/v1/statement/summary`, StatementSummary),
    account: () => call(`${P}/v1/account`, AccountInfo),
    activity: (q: ActivityQuery) => call(buildActivityPath(q), ActivityPage),
    statementPdfLink: (range: { from?: string; to?: string }) =>
      call(`${P}/v1/statement/pdf-link`, PdfLink, { method: 'POST', body: range }),
    invoicePdfLink: (id: string) =>
      call(`${P}/v1/invoices/${encodeURIComponent(id)}/pdf-link`, PdfLink, { method: 'POST', body: {} }),
  };
}
export type Api = ReturnType<typeof createApi>;

/** Session-token getter for the real extension runtime (global `shopify`). */
export const shopifyToken = (): Promise<string> => (globalThis as any).shopify.sessionToken.get();
