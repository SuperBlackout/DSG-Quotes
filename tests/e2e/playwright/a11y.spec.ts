/**
 * LIVE STORE (skipped unless E2E_STORE_URL is set). axe-core on mockup screens 1-7, zero serious/critical violations.
 * Screens 3-5 render inside Shopify's customer account sandbox and 6-7 inside the admin iframe, so axe is pointed at the
 * extension / iframe content; violations coming from Shopify's own chrome are out of scope (scope selectors below).
 */
import { test } from "@playwright/test";
import { env, requireLiveStore } from "./support/env";
import { adminApp, expectNoSeriousA11yViolations, openStorefront } from "./support/helpers";

requireLiveStore("dealerA", "rep", "admin");

test.describe("axe: storefront (screens 1 and 2)", () => {
  test.use({ storageState: env.state.dealerA });

  test("screen 1: product page with the Add to Quote button and the open popover", async ({ page }) => {
    await openStorefront(page, env.productPath);
    await expectNoSeriousA11yViolations(page, "[data-dsg-add-to-quote]", "screen 1 closed");
    await page.locator("[data-dsg-trigger]").click();
    await page.locator("[data-dsg-popover]").waitFor();
    await expectNoSeriousA11yViolations(page, "[data-dsg-add-to-quote]", "screen 1 popover open");
  });

  test("screen 2: cart page with the Move cart to quote form", async ({ page }) => {
    await openStorefront(page, env.productPath);
    await page.locator('form[action*="/cart/add"] [type="submit"], button[name="add"]').first().click();
    await page.goto("/cart");
    await page.locator("[data-dsg-move-cart]").waitFor();
    await expectNoSeriousA11yViolations(page, "[data-dsg-move-cart]", "screen 2");
  });
});

test.describe("axe: customer account (screens 3, 4, 5)", () => {
  test.use({ storageState: env.state.dealerA });

  test("screen 3: My Quotes list", async ({ page }) => {
    await page.goto(env.myQuotesPath);
    await page.getByRole("heading", { name: "My Quotes" }).waitFor();
    await expectNoSeriousA11yViolations(page, "main", "screen 3");
  });

  test("screen 4: quote detail with conversation", async ({ page }) => {
    await page.goto(env.myQuotesPath);
    await page.getByText("E2E multi-version").first().click();
    await page.getByRole("heading", { name: "Conversation" }).waitFor();
    await expectNoSeriousA11yViolations(page, "main", "screen 4");
  });

  test("screen 5: notification settings", async ({ page }) => {
    await page.goto(`${env.myQuotesPath}/notifications`);
    await page.getByRole("heading", { name: /notification/i }).waitFor();
    await expectNoSeriousA11yViolations(page, "main", "screen 5");
  });
});

test.describe("axe: admin app (screens 6 and 7)", () => {
  test.use({ storageState: env.state.rep });

  test("screen 6: sales inbox", async ({ page }) => {
    await page.goto(env.adminAppUrl);
    await adminApp(page).getByRole("heading", { name: "Quote inbox" }).waitFor();
    // AxeBuilder injects axe into every frame, so including the iframe element analyses the app inside it.
    await expectNoSeriousA11yViolations(page, "iframe[name='app-iframe']", "screen 6");
  });

  test("screen 7: sales editor", async ({ page }) => {
    await page.goto(env.adminAppUrl);
    const app = adminApp(page);
    await app.getByLabel("Search").fill("E2E");
    await app.getByText(/Q-\d+/).first().click();
    await app.getByRole("heading", { name: "Line items" }).waitFor();
    await expectNoSeriousA11yViolations(page, "iframe[name='app-iframe']", "screen 7");
  });
});
