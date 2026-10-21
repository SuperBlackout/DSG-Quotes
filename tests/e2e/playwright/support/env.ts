import { existsSync } from "node:fs";
import { test } from "@playwright/test";

/** Everything the live specs need, all from the environment. No real customer data: use the dev store fixtures. */
export const env = {
  /** Storefront origin of the dev store, e.g. https://dsg-dev.myshopify.com. Unset = every live spec is skipped. */
  storeUrl: process.env.E2E_STORE_URL ?? "",
  /** Storefront password if the dev store is password protected. */
  storePassword: process.env.E2E_STORE_PASSWORD ?? "",
  /** A product page with a quotable variant, e.g. /products/copper-pipe-10ft. */
  productPath: process.env.E2E_PRODUCT_PATH ?? "/products/e2e-widget",
  /** Customer Account page that hosts the My Quotes full-page extension (new customer accounts). */
  myQuotesPath: process.env.E2E_MY_QUOTES_PATH ?? "/account/extensions/my-quotes",
  /** Embedded admin app URL, e.g. https://admin.shopify.com/store/dsg-dev/apps/dsg-quotes */
  adminAppUrl: process.env.E2E_ADMIN_APP_URL ?? "",
  /**
   * Logged-in browser sessions saved with `npx playwright codegen --save-storage=.auth/<name>.json <url>`.
   * New customer accounts use one-time email codes, so these cannot be scripted; refresh them when they expire.
   */
  state: {
    dealerA: process.env.E2E_DEALER_A_STATE ?? ".auth/dealer-a.json", // Acme dealer 1
    dealerB: process.env.E2E_DEALER_B_STATE ?? ".auth/dealer-b.json", // Acme dealer 2 (colleague)
    dealerC: process.env.E2E_DEALER_C_STATE ?? ".auth/dealer-c.json", // Other Co dealer (cross-company checks)
    rep: process.env.E2E_REP_STATE ?? ".auth/rep.json", // sales rep, Shopify admin
    manager: process.env.E2E_MANAGER_STATE ?? ".auth/manager.json", // sales manager, Shopify admin
  },
};

export const live = !!env.storeUrl;

/** Call at the top of a spec file. Skips the whole file with a clear reason when no live store is configured. */
export function requireLiveStore(...needs: ("dealerA" | "dealerB" | "dealerC" | "rep" | "manager" | "admin")[]): void {
  test.skip(!live, "E2E_STORE_URL is not set: live dev-store specs are skipped (see tests/e2e/README.md)");
  for (const n of needs) {
    if (n === "admin") test.skip(live && !env.adminAppUrl, "E2E_ADMIN_APP_URL is not set");
    else test.skip(live && !existsSync(env.state[n]), `Missing saved login ${env.state[n]} for ${n} (see README: saving logins)`);
  }
}
