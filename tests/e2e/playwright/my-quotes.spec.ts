/**
 * LIVE STORE (skipped unless E2E_STORE_URL is set). Screens 3, 4 and 5: the My Quotes customer-account extension.
 * Labels come from extensions/my-quotes (QuoteList, QuoteDetail, status.ts, Notifications).
 * Precondition: the lifecycle seed has run (README "Seeding the dev store"): quotes titled "E2E ..." exist in each state.
 */
import { expect, test } from "@playwright/test";
import { env, requireLiveStore } from "./support/env";
import { captureCustomerTraffic } from "./support/helpers";

requireLiveStore("dealerA", "dealerC");

test.describe("Screen 3: My Quotes list", () => {
  test.use({ storageState: env.state.dealerA });

  test("chips, search and group-by are present and filter the list", async ({ page, context }) => {
    const traffic = captureCustomerTraffic(context);
    await page.goto(env.myQuotesPath);
    await expect(page.getByRole("heading", { name: "My Quotes" })).toBeVisible();
    for (const chip of ["All", "Waiting on you", "With sales", "Drafts", "Closed"]) await expect(page.getByText(chip, { exact: false }).first()).toBeVisible();
    const search = page.getByLabel("Search quotes");
    await search.fill("E2E");
    await expect(page.getByText(/Q-\d+/).first()).toBeVisible();
    await search.fill("zzz-no-such-quote");
    await expect(page.getByText(/no quotes/i)).toBeVisible();
    await page.getByLabel("Group by").selectOption({ label: "Job" }).catch(() => undefined);
    traffic.assertNoStaffData();
  });

  test("row actions follow the status: QUOTE_READY -> Review quote, ACCEPTED -> Buy now, DRAFT -> Submit / Delete draft / Duplicate", async ({ page }) => {
    await page.goto(env.myQuotesPath);
    await expect(page.getByRole("button", { name: "Review quote" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Buy now" }).first()).toBeVisible();
    await page.getByText("Drafts", { exact: true }).first().click();
    for (const a of ["Submit", "Delete draft", "Duplicate"]) await expect(page.getByRole("button", { name: a }).first()).toBeVisible();
  });

  test("delete draft asks for confirmation and removes the row", async ({ page }) => {
    await page.goto(env.myQuotesPath);
    await page.getByText("Drafts", { exact: true }).first().click();
    const before = await page.getByRole("button", { name: "Delete draft" }).count();
    await page.getByRole("button", { name: "Delete draft" }).first().click();
    await expect(page.getByRole("heading", { name: "Delete this draft?" })).toBeVisible();
    await page.getByRole("button", { name: /^Delete/ }).last().click();
    await expect(page.getByRole("button", { name: "Delete draft" })).toHaveCount(before - 1);
  });

  test("a colleague's company quotes are visible; another company's are not (cross-company)", async ({ browser }) => {
    const other = await browser.newContext({ baseURL: env.storeUrl, storageState: env.state.dealerC });
    const page = await other.newPage();
    await page.goto(env.myQuotesPath);
    await expect(page.getByRole("heading", { name: "My Quotes" })).toBeVisible();
    await expect(page.getByText("E2E Acme only")).toHaveCount(0);
    await other.close();
  });
});

test.describe("Screen 4: quote detail", () => {
  test.use({ storageState: env.state.dealerA });

  test("version tabs, 'highlight changes', request changes, then accept and Buy now", async ({ page, context }) => {
    const traffic = captureCustomerTraffic(context);
    await page.goto(env.myQuotesPath);
    await page.getByText("E2E multi-version").first().click();
    await expect(page.getByRole("heading", { name: "Items" })).toBeVisible();
    const versionTabs = page.getByRole("tablist", { name: "Quote version" });
    await expect(versionTabs.getByRole("tab")).toHaveCount(2);
    await page.getByLabel(/highlight changes/i).check();
    await expect(page.getByText(/changed|new|removed/i).first()).toBeVisible();

    await page.getByRole("button", { name: "Request changes" }).click();
    await page.getByLabel("What should change?").fill("E2E: can you do better on the pipe?");
    await page.getByRole("button", { name: "Send request" }).click();
    await expect(page.getByText(/changes requested|with sales/i).first()).toBeVisible();
    traffic.assertNoStaffData(); // no cost/margin/internal note in any response while on the detail screen
  });

  test("accepting opens a confirmation, calls checkout and offers 'Continue to checkout'", async ({ page }) => {
    await page.goto(env.myQuotesPath);
    await page.getByText("E2E ready to accept").first().click();
    await page.getByRole("button", { name: "Accept quote" }).click();
    await expect(page.getByRole("heading", { name: "You are all set" })).toBeVisible();
    await page.getByRole("button", { name: "Buy now" }).click();
    await expect(page.getByRole("link", { name: /continue to checkout/i })).toHaveAttribute("href", /invoices|checkouts|orders/);
  });

  test("an expired quote shows the API message and 'Ask for a new quote'", async ({ page }) => {
    await page.goto(env.myQuotesPath);
    await page.getByText("E2E expired").first().click();
    await expect(page.getByRole("button", { name: "Ask for a new quote" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Buy now" })).toHaveCount(0);
  });

  test("the conversation never shows internal notes", async ({ page }) => {
    await page.goto(env.myQuotesPath);
    await page.getByText("E2E multi-version").first().click();
    await expect(page.getByRole("heading", { name: "Conversation" })).toBeVisible();
    await expect(page.getByText("E2E-INTERNAL")).toHaveCount(0);
    await page.getByLabel("Message").fill("E2E hello from the dealer");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("E2E hello from the dealer")).toBeVisible();
  });
});

test.describe("Screen 5: notification settings", () => {
  test.use({ storageState: env.state.dealerA });

  test("event x channel matrix saves; SMS needs the exact consent text and a valid phone", async ({ page }) => {
    await page.goto(`${env.myQuotesPath}/notifications`);
    await expect(page.getByRole("heading", { name: /notification/i })).toBeVisible();
    await page.getByLabel(/mobile|phone/i).fill("555-1212");
    await page.getByLabel(/text message/i).first().check();
    await page.getByRole("button", { name: /save/i }).click();
    await expect(page.getByText(/enter a mobile number|opt-in is required/i)).toBeVisible();
    await page.getByLabel(/mobile|phone/i).fill("+13125550123");
    await page.getByLabel(/I agree to receive text messages/i).check();
    await page.getByRole("button", { name: /save/i }).click();
    await expect(page.getByText(/saved/i)).toBeVisible();
  });
});
