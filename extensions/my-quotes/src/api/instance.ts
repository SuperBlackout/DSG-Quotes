// The one API client the UI uses. Built lazily because `shopify` (session token, settings) only
// exists once the extension is running.
import { createApiClient, type ApiClient } from "./client";

/**
 * Fallback when the merchant has not filled the "Quotes API base URL" extension setting.
 * Matches the custom domain planned in docs/SETUP.md section 4. Must serve /c/* with
 * `Access-Control-Allow-Origin: *` (extensions run in a Web Worker with a null origin) and accept
 * `Authorization: Bearer <customer-account session token>`.
 */
export const DEFAULT_API_BASE_URL = "https://quotes.dsg.direct";

export function resolveBaseUrl(): string {
  try {
    const configured = shopify.settings.value?.api_base_url;
    if (typeof configured === "string" && /^https:\/\//.test(configured.trim())) return configured.trim();
  } catch {
    // settings unavailable in some preview contexts: use the default
  }
  return DEFAULT_API_BASE_URL;
}

let client: ApiClient | undefined;

export function api(): ApiClient {
  client ??= createApiClient({
    baseUrl: resolveBaseUrl(),
    // Request the token right before each call; it expires after 5 minutes.
    getToken: () => shopify.sessionToken.get(),
  });
  return client;
}
