import { defineConfig, devices } from "@playwright/test";

/**
 * WRITTEN-BUT-NOT-RUNNABLE layer: specs against a live Shopify dev store. Every spec skips itself unless
 * E2E_STORE_URL is set (see playwright/support/env.ts and tests/e2e/README.md). Not validated against a real store yet.
 */
export default defineConfig({
  testDir: "./playwright",
  testMatch: /.*\.spec\.ts/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: process.env.E2E_STORE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
