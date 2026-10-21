// Types the `shopify` global for the customer-account.page.render target. Same mechanism the Shopify
// CLI scaffold generates: a per-module declaration, one entry per source file that reads `shopify`.
// (The package's own global `shopify` is the generic ShopifyGlobal, which has no target API.)
import "@shopify/ui-extensions/preact";

declare module "./src/api/instance.ts" {
  const shopify: import("@shopify/ui-extensions/customer-account.page.render").Api;
  const globalThis: { shopify: typeof shopify };
}
