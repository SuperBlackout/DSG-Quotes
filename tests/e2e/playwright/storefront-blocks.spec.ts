/**
 * LIVE STORE (skipped unless E2E_STORE_URL is set). Screens 1 and 2: theme app extension blocks.
 * Selectors come from extensions/quote-blocks (data-dsg-* attributes, aria labels, button text).
 */
import { expect, test } from "@playwright/test";
import { env, requireLiveStore } from "./support/env";
import { captureCustomerTraffic, openStorefront } from "./support/helpers";

requireLiveStore("dealerA");

test.describe("Screen 1: Add to Quote on the product page", () => {
  test("logged-out visitors see 'Sign in to request a quote' and no popover", async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: env.storeUrl });
    const page = await ctx.newPage();
    await openStorefront(page, env.productPath);
    const signIn = page.locator("[data-dsg-signin]");
    await expect(signIn).toBeVisible();
    await expect(signIn).toContainText("Sign in to request a quote");
    await expect(page.locator("[data-dsg-trigger]")).toHaveCount(0);
    await ctx.close();
  });

  test.describe("signed in as a dealer", () => {
    test.use({ storageState: env.state.dealerA });

    test("popover is a labelled dialog; Esc closes it and returns focus to the trigger", async ({ page }) => {
      await openStorefront(page, env.productPath);
      const trigger = page.locator("[data-dsg-trigger]");
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      const pop = page.getByRole("dialog", { name: /add .* to which quote/i });
      await expect(pop).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(pop).toBeHidden();
      await expect(trigger).toBeFocused();
    });

    test("focus stays inside the popover while tabbing", async ({ page }) => {
      await openStorefront(page, env.productPath);
      await page.locator("[data-dsg-trigger]").click();
      const pop = page.locator("[data-dsg-popover]");
      await expect(pop).toBeVisible();
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press("Tab");
        expect(await pop.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      }
    });

    test("'Start a new quote' needs a job name, then adds the product and shows 'View quote'", async ({ page, context }) => {
      const traffic = captureCustomerTraffic(context);
      await openStorefront(page, env.productPath);
      await page.locator("[data-dsg-trigger]").click();
      await page.getByLabel("Start a new quote").check();
      await page.getByRole("button", { name: "Add to quote" }).click();
      await expect(page.getByRole("alert")).toContainText("job name");
      await page.getByLabel("Job name").fill(`E2E job ${Date.now()}`);
      await page.getByLabel("PO number (optional)").fill("E2E-PO-1");
      await page.getByRole("button", { name: "Add to quote" }).click();
      await expect(page.getByText("Added to your quote")).toBeVisible();
      await expect(page.getByRole("link", { name: "View quote" })).toBeVisible();
      // The header chip (app embed) now shows the target quote.
      await expect(page.locator("[data-dsg-chip]")).toBeVisible();
      await expect(page.locator("[data-dsg-chip-text]")).toContainText(/Q-\d+/);
      traffic.assertNoStaffData(); // Screen 1 never receives cost or margin
    });

    test("adding to an existing draft uses the radio list and keeps the same quote", async ({ page }) => {
      await openStorefront(page, env.productPath);
      await page.locator("[data-dsg-trigger]").click();
      const first = page.locator('[data-dsg-popover] input[type="radio"]').first();
      await first.check();
      await page.getByRole("button", { name: "Add to quote" }).click();
      await expect(page.getByText("Added to your quote")).toBeVisible();
      await page.getByRole("button", { name: "Keep shopping" }).click();
      await expect(page.locator("[data-dsg-trigger]")).toBeFocused();
    });
  });
});

test.describe("Screen 2: Move cart to quote", () => {
  test.use({ storageState: env.state.dealerA });

  async function fillCart(page: import("@playwright/test").Page) {
    await openStorefront(page, env.productPath);
    await page.locator('form[action*="/cart/add"] [type="submit"], button[name="add"]').first().click();
    await page.goto("/cart");
  }

  test("save as draft: copies the cart, empties it only after success, links to the new quote", async ({ page, context }) => {
    const traffic = captureCustomerTraffic(context);
    await fillCart(page);
    const block = page.locator("[data-dsg-move-cart]");
    await expect(block).toBeVisible();
    await expect(block.getByText(/items? in your cart will be copied/)).toBeVisible();
    await block.getByLabel("Job name").fill(`E2E cart ${Date.now()}`);
    await block.getByLabel("PO #").fill("E2E-PO-2");
    await block.getByLabel("Note to sales").fill("E2E note");
    await expect(block.getByLabel("Empty my cart after moving")).toBeChecked();
    await block.getByRole("button", { name: "Save as draft" }).click();
    await expect(block.getByText("Draft saved")).toBeVisible();
    await expect(block.getByRole("link", { name: "View quote" })).toBeVisible();
    const cart = await page.evaluate(() => fetch("/cart.js").then((r) => r.json()));
    expect(cart.item_count).toBe(0);
    traffic.assertNoStaffData();
  });

  test("submit to sales: the quote is SUBMITTED and the cart is cleared", async ({ page }) => {
    await fillCart(page);
    const block = page.locator("[data-dsg-move-cart]");
    await block.getByLabel("Job name").fill(`E2E submit ${Date.now()}`);
    await block.getByRole("button", { name: "Submit to sales" }).click();
    await expect(block.getByText("Sent to sales")).toBeVisible();
    await expect(block.getByRole("status")).toContainText("Submitted to sales");
  });

  test("a missing job name blocks the request, focuses the field and leaves the cart alone", async ({ page }) => {
    await fillCart(page);
    const block = page.locator("[data-dsg-move-cart]");
    await block.getByRole("button", { name: "Submit to sales" }).click();
    await expect(block.getByRole("alert")).toContainText("job name");
    await expect(block.getByLabel("Job name")).toBeFocused();
    const cart = await page.evaluate(() => fetch("/cart.js").then((r) => r.json()));
    expect(cart.item_count).toBeGreaterThan(0);
  });

  test("a failing API call keeps the cart (cart is only cleared after a 2xx)", async ({ page }) => {
    await fillCart(page);
    await page.route("**/apps/quotes/c/quotes/from-cart**", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "INTERNAL", message: "Something went wrong" }) }));
    const block = page.locator("[data-dsg-move-cart]");
    await block.getByLabel("Job name").fill("E2E failing");
    await block.getByRole("button", { name: "Save as draft" }).click();
    await expect(block.getByRole("alert")).toBeVisible();
    const cart = await page.evaluate(() => fetch("/cart.js").then((r) => r.json()));
    expect(cart.item_count).toBeGreaterThan(0);
  });
});
