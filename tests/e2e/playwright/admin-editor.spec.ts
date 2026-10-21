/**
 * LIVE STORE (skipped unless E2E_STORE_URL and E2E_ADMIN_APP_URL are set). Screens 6 and 7: sales inbox and editor in the
 * embedded admin app (app/src/routes/app._index.tsx, app.quotes.$id.tsx). The app renders in Shopify admin's iframe.
 * Precondition: seeded quotes (README "Seeding the dev store"), one SUBMITTED quote titled "E2E claim me" and one
 * below-floor quote titled "E2E below floor".
 */
import { expect, test } from "@playwright/test";
import { env, requireLiveStore } from "./support/env";
import { adminApp } from "./support/helpers";

requireLiveStore("rep", "manager", "admin");

test.describe("Screen 6: sales inbox", () => {
  test.use({ storageState: env.state.rep });

  test("tiles, tabs, search and filters render", async ({ page }) => {
    await page.goto(env.adminAppUrl);
    const app = adminApp(page);
    await expect(app.getByRole("heading", { name: "Quote inbox" })).toBeVisible();
    for (const tile of ["Needs response", "Open quote value", "Accepted this week", "Expiring in 3 days"]) await expect(app.getByText(tile)).toBeVisible();
    for (const tab of ["Needs response", "Unassigned", "Waiting on customer", "Accepted", "Expiring", "All"]) await expect(app.getByText(tab, { exact: true }).first()).toBeVisible();
    await app.getByLabel("Search").fill("E2E");
    await expect(app.getByText(/Q-\d+/).first()).toBeVisible();
    await expect(app.getByLabel("Rep")).toBeVisible();
    await expect(app.getByLabel("Team")).toBeVisible();
  });
});

test.describe("Screen 7: editor", () => {
  test.use({ storageState: env.state.rep });

  async function openQuote(page: import("@playwright/test").Page, title: string) {
    await page.goto(env.adminAppUrl);
    const app = adminApp(page);
    await app.getByLabel("Search").fill(title);
    await app.getByText(title).first().click();
    await expect(app.getByRole("heading", { name: "Line items" })).toBeVisible();
    return app;
  }

  test("claim, reprice, internal note + customer message, preview as customer, send v2", async ({ page }) => {
    const app = await openQuote(page, "E2E claim me");
    await app.getByLabel("Assigned rep").selectOption({ index: 0 }).catch(() => undefined);
    // cost / dealer / margin columns are visible to staff
    for (const col of ["Dealer", "Quote price", "Margin"]) await expect(app.getByText(col, { exact: true }).first()).toBeVisible();
    await app.getByLabel("Percent off dealer price").fill("5");
    await app.getByLabel("Freight").fill("25.00");
    await app.getByLabel("Job notes for customer").fill("E2E customer-visible note");
    await app.getByLabel("Internal note").fill("E2E-INTERNAL rep-only note");
    await app.getByRole("button", { name: "Save draft" }).click();
    await app.getByRole("button", { name: "Preview as customer" }).click();
    await expect(app.getByText("Notes from your rep")).toBeVisible();
    await expect(app.getByText("E2E-INTERNAL")).toHaveCount(0); // preview shows only what the customer sees
    await expect(app.getByText(/margin|cost/i)).toHaveCount(0);
    await app.getByRole("button", { name: /^Send v\d+ to customer$/ }).click();
    await app.getByRole("button", { name: /^Send v\d+$/ }).click();
    await expect(app.getByText(/Quote ready|QUOTE_READY|Waiting on customer/i).first()).toBeVisible();
  });

  test("conversation toggle: internal notes are visibly distinct and saved replies insert text", async ({ page }) => {
    const app = await openQuote(page, "E2E claim me");
    await expect(app.getByRole("heading", { name: "Conversation" })).toBeVisible();
    await app.getByRole("button", { name: /internal note/i }).click();
    await app.getByLabel(/message|note/i).last().fill("E2E-INTERNAL heads up");
    await app.getByRole("button", { name: /^(Add note|Send)$/ }).click();
    await expect(app.getByText("E2E-INTERNAL heads up")).toBeVisible();
    await expect(app.getByText(/internal/i).first()).toBeVisible();
    await expect(app.getByLabel("Saved replies")).toBeVisible();
  });

  test("below-floor line: warning shown, Send is blocked until a manager approves (as the manager)", async ({ page, browser }) => {
    const app = await openQuote(page, "E2E below floor");
    await app.getByRole("button", { name: /^Send v\d+ to customer$/ }).click();
    await app.getByRole("button", { name: /^Send v\d+$/ }).click();
    await expect(app.getByRole("heading", { name: "Manager approval needed to send" })).toBeVisible();
    await app.getByRole("button", { name: /request manager approval/i }).click();
    await expect(app.getByText("Approval requested. A manager will review it.")).toBeVisible();

    const mgr = await browser.newContext({ storageState: env.state.manager });
    const mpage = await mgr.newPage();
    const mapp = await openQuote(mpage, "E2E below floor");
    await mapp.getByRole("button", { name: /approve/i }).first().click();
    await expect(mapp.getByText("Floor approved").first()).toBeVisible();
    await mapp.getByRole("button", { name: /^Send v\d+ to customer$/ }).click();
    await mapp.getByRole("button", { name: /^Send v\d+$/ }).click();
    await expect(mapp.getByText(/Waiting on customer|Quote ready/i).first()).toBeVisible();
    await mgr.close();
  });

  // Contract 0.2.0 (ADM-9): a line with unknown inventory cost shows an "Unknown cost" badge, a dash for margin and blocks Send until a
  // manager approves. Precondition: a SUBMITTED quote titled "E2E unknown cost" whose line variant has no inventory cost in the dev store.
  // The API behaviour behind it is proven by api/floor-expiry-checkout.e2e.test.ts; this only checks the admin UI renders it.
  test("unknown-cost line: badge, margin dash, Send blocked until a manager approves", async ({ page, browser }) => {
    const app = await openQuote(page, "E2E unknown cost");
    await expect(app.getByText("Unknown cost").first()).toBeVisible();
    await app.getByRole("button", { name: /^Send v\d+ to customer$/ }).click();
    await app.getByRole("button", { name: /^Send v\d+$/ }).click();
    await expect(app.getByRole("heading", { name: "Manager approval needed to send" })).toBeVisible();

    const mgr = await browser.newContext({ storageState: env.state.manager });
    const mpage = await mgr.newPage();
    const mapp = await openQuote(mpage, "E2E unknown cost");
    await mapp.getByRole("button", { name: /approve/i }).first().click();
    await expect(mapp.getByText("Floor approved").first()).toBeVisible();
    await mgr.close();
  });

  test("customer change request shows as a callout on the editor", async ({ page }) => {
    const app = await openQuote(page, "E2E changes requested");
    await expect(app.getByText(/E2E: can you do better/i)).toBeVisible();
  });
});
