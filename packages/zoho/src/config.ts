import { ZohoConfigError } from './errors.js';

export interface ZohoConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  orgId: string;
  apiBase: string;
  accountsBase: string;
  /** Where the customer number lives on a contact: a top-level key (default `contact_number`) or a custom field label/api_name/`cf_*` key. */
  customerNumberField: string;
}

export const DEFAULT_API_BASE = 'https://www.zohoapis.com/books/v3';
export const DEFAULT_ACCOUNTS_BASE = 'https://accounts.zoho.com';

export function loadZohoConfigFromEnv(env: Record<string, string | undefined> = process.env): ZohoConfig {
  const required = ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_ORG_ID'];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) throw new ZohoConfigError(`Missing Zoho env vars: ${missing.join(', ')}`);
  return {
    clientId: env.ZOHO_CLIENT_ID!,
    clientSecret: env.ZOHO_CLIENT_SECRET!,
    refreshToken: env.ZOHO_REFRESH_TOKEN!,
    orgId: env.ZOHO_ORG_ID!,
    apiBase: env.ZOHO_API_BASE || DEFAULT_API_BASE,
    accountsBase: env.ZOHO_ACCOUNTS_BASE || DEFAULT_ACCOUNTS_BASE,
    customerNumberField: env.ZOHO_CUSTOMER_NUMBER_FIELD || 'contact_number',
  };
}
