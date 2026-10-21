/**
 * Shopify API pins. Change only via a lead PR, then re-run `pnpm -F api graphql:validate`.
 *
 * NOTE: "2026-07" follows Shopify's quarterly cadence (YYYY-01/04/07/10). CONFIRM against
 * https://shopify.dev/docs/api/usage/versioning that 2026-07 is a stable (not RC) release before
 * the first deploy; fall back to the latest stable version otherwise.
 */
export const ADMIN_API_VERSION = "2026-07" as const;

export const ADMIN_GRAPHQL_PATH = `/admin/api/${ADMIN_API_VERSION}/graphql.json`;

/** Admin API access scopes requested by the app (keep in sync with shopify.app.toml). */
export const APP_SCOPES = [
  "read_customers",
  "read_companies",
  "read_products",
  "read_inventory",
  "read_orders",
  "write_draft_orders",
  "read_draft_orders",
  "read_price_rules",
] as const;
