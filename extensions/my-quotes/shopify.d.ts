// Types the global `shopify` object for the customer-account.page.render target
// (same shape the Shopify CLI scaffold generates). Every module under src/ sees it.
import "@shopify/ui-extensions/preact";
import type { Api } from "@shopify/ui-extensions/customer-account.page.render";

declare global {
  const shopify: Api;
}
