/**
 * Where the account pages (statement + account info) get their data: the DSG Quotes API, same origin as My Quotes.
 * The merchant can override it per environment with the extension setting "Quotes API base URL" (api_base_url),
 * exactly like My Quotes; this default is the production custom domain.
 */
export const DEFAULT_API_BASE_URL = 'https://quotes.dsg.direct';
/** The account routes live under /a on that origin (see apps/api/src/statement/routes.ts). */
export const ACCOUNT_API_PREFIX = '/a';
export const PAGE_SIZE = 25;

export function resolveBaseUrl(): string {
  try {
    const configured = (globalThis as any).shopify?.settings?.value?.api_base_url;
    if (typeof configured === 'string' && /^https:\/\//.test(configured.trim())) return configured.trim().replace(/\/+$/, '');
  } catch {
    // settings unavailable (preview contexts, tests): use the default
  }
  return DEFAULT_API_BASE_URL;
}
