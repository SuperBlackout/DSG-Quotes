/**
 * Browser-only API access. Session tokens come from App Bridge (`shopify.idToken()`), which is available
 * on the `shopify` global once the App Bridge script (loaded by <AppProvider>) has run.
 *
 * UNVERIFIED without a live store: that the global exists before the first clientLoader runs on hydrate.
 * We wait up to 5 s for it, which covers the script-load race.
 */
import { createStaffClient, type StaffClient } from "./api-client";

type ShopifyGlobal = typeof shopify;
const globalShopify = (): ShopifyGlobal | undefined => (globalThis as { shopify?: ShopifyGlobal }).shopify;

async function waitForShopify(timeoutMs = 5000): Promise<ShopifyGlobal> {
  const start = Date.now();
  while (typeof window !== "undefined") {
    const s = globalShopify();
    if (s) return s;
    if (Date.now() - start > timeoutMs) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Shopify App Bridge is not available. Open this app from the Shopify admin.");
}

let cached: { staff: StaffClient } | null = null;

export function getBrowserClients() {
  if (!cached) {
    const staff = createStaffClient({
      baseUrl: "/api",
      getToken: async () => (await waitForShopify()).idToken(),
    });
    cached = { staff };
  }
  return cached;
}
