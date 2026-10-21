import AxeBuilder from "@axe-core/playwright";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { env } from "./env";

/** Same idea as api/support/leak.ts: nothing staff-only may appear in a customer-facing network response. */
const FORBIDDEN_KEYS = ["cost", "unitCost", "margin", "marginPct", "marginTotal", "internalNote", "internal", "belowFloor", "floorApproved", "workingLines", "workingInternalNote"];

export interface Capture {
  /** Every /apps/quotes/* and /c/* JSON response seen while the page ran. */
  bodies: { url: string; status: number; text: string }[];
  assertNoStaffData(): void;
}

/** Start recording quote API responses (storefront app proxy and customer account extension calls). */
export function captureCustomerTraffic(context: BrowserContext): Capture {
  const bodies: Capture["bodies"] = [];
  context.on("response", async (res) => {
    const url = res.url();
    if (!/\/apps\/quotes\/|\/c\/(quotes|active-quote|notification-prefs)/.test(url)) return;
    try {
      bodies.push({ url, status: res.status(), text: await res.text() });
    } catch {
      /* redirects / aborted requests have no body */
    }
  });
  return {
    bodies,
    assertNoStaffData() {
      expect(bodies.length, "expected the page to call the quotes API at least once").toBeGreaterThan(0);
      for (const b of bodies) {
        for (const k of FORBIDDEN_KEYS) expect(b.text, `${b.url} leaked key "${k}"`).not.toMatch(new RegExp(`"${k}"\\s*:`));
        expect(b.text, `${b.url} leaked internal text`).not.toContain("E2E-INTERNAL");
      }
    },
  };
}

/** Open the storefront, passing the password page if the dev store has one. */
export async function openStorefront(page: Page, path = "/"): Promise<void> {
  await page.goto(path);
  if (env.storePassword && (await page.locator('form[action$="/password"]').count())) {
    await page.locator('input[type="password"]').fill(env.storePassword);
    await page.getByRole("button", { name: /enter/i }).click();
    await page.goto(path);
  }
}

/** The embedded admin app renders inside Shopify admin's app iframe. */
export const adminApp = (page: Page) => page.frameLocator('iframe[name="app-iframe"]');

/** Zero serious or critical axe violations, scoped to the screen under test. */
export async function expectNoSeriousA11yViolations(page: Page, scope?: string, label = "page"): Promise<void> {
  let axe = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  if (scope) axe = axe.include(scope);
  const { violations } = await axe.analyze();
  const serious = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(
    serious.map((v) => `${v.id} (${v.impact}): ${v.help} -> ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`),
    `axe violations on ${label}`,
  ).toEqual([]);
}
