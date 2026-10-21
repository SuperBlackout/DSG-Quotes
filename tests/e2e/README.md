# tests/e2e

Owner: **qa agent**. See `docs/AGENTS.md` section 6 and `docs/ISSUES.md` ISSUE-6.

Two layers. Be clear about which is which:

| Layer | Where | Status |
| --- | --- | --- |
| **1. Runnable now** | `api/**/*.e2e.test.ts` (vitest) | Boots the real API (`apps/api`) on a throwaway Postgres with the fake Shopify gateway and drives the whole lifecycle over HTTP. **Passes today.** |
| **2. Written, not runnable yet** | `playwright/*.spec.ts` | Playwright + axe against a live dev store. **Never run against a real store**; selectors come from reading the extension and admin source. Every spec skips unless `E2E_STORE_URL` is set. |

## Layer 1: API lifecycle + contract (runnable)

```bash
# any empty Postgres 16. The database is WIPED (schema public dropped) at the start of every run.
# Default: postgresql://postgres@127.0.0.1:5433/dsg_test   (same server `pnpm -F api test` uses)
export E2E_DATABASE_URL=postgresql://postgres@127.0.0.1:5433/dsg_e2e   # optional; use a separate DB to run next to `pnpm -F api test`
pnpm -F e2e test          # vitest run
pnpm -F e2e typecheck
```

The DB name must contain `test`, `e2e`, `scratch` or `tmp` or the run refuses to start (`E2E_ALLOW_WIPE=1` overrides).
Do not run this and `pnpm -F api test` at the same time against the SAME database.

If `prisma generate` is blocked (no access to binaries.prisma.sh), run it with `PRISMA_SCHEMA_ENGINE_BINARY=/bin/true`
or copy the generated `.prisma/client` folder from another checkout's `node_modules/.pnpm/@prisma+client*/node_modules/`.
After adding this package's dependencies run `pnpm install` once (the lead must regenerate `pnpm-lock.yaml`; QA does not edit it).

What it covers (fixtures: 2 companies, 3 dealers, 2 reps, 1 manager, in `api/support/world.ts` and `fixtures.ts`):

| File | Covers |
| --- | --- |
| `lifecycle.e2e.test.ts` | PDP add, submit, claim, reprice, send v1, revise + send v2, customer diff, request changes, v3, stale accept (409 `VERSION_MISMATCH`), accept, checkout (idempotent), `orders/create` webhook, ORDERED, one `events` row per transition |
| `drafts.e2e.test.ts` | Screen 1 through the app proxy, cart to quote (new / existing / submit), price snapshots, line edits, withdraw, delete draft, duplicate, decline, reopen, conversation, attachments |
| `floor-expiry-checkout.e2e.test.ts` | Floor approval flow, expiry (lazy + cron stand-in), net terms, Shopify failure, concurrent Buy clicks, webhooks |
| `privacy-scoping.e2e.test.ts` | Internal notes, cost and margin never in `/c`; auth boundaries; cross-company and cross-location access is 404 on every `/c` route in every status |
| `contract.e2e.test.ts` | Spec sanity, notification prefs, staff create/assign, filters, pagination, error shapes, anonymous 401 on every operation |
| `zz-coverage.e2e.test.ts` | Fails if any `/c` or `/s` operation was never hit with a success and an error status |
| `known-bugs.e2e.test.ts` | Backend bugs found by QA, written as `it.fails`: green now, red when fixed (then drop `.fails`) |

Enforced on EVERY request by the harness (`api/support/world.ts`), not just in dedicated tests:

- the response validates against `docs/openapi.yaml` (own validator in `api/support/contract.ts`: unknown keys, required, enums, formats, nullable, oneOf);
  a route served by the API but missing from the contract fails the test;
- the request body the test sent validates against the contract when the API accepted it (unless `{ loose: true }`);
- every `/c` response (success or error) is deep-scanned (`api/support/leak.ts`) for staff-only keys, planted internal text, planted unit costs and margins.

Not covered here: the worker (`apps/worker`, not built) and the `/hooks/email-inbound`, `/hooks/twilio-inbound` operations; the expiry cron is
simulated by `world.runExpiryCron()` using the API's own transition code. Replace it with the worker's job when it exists.

## Layer 2: Playwright against a live dev store (written, not runnable yet)

Prerequisite: `docs/SETUP.md` complete through step 3 (dev store with B2B, 2 companies, 3 dealers, rep + manager staff accounts, app installed, theme blocks
enabled on the product and cart templates, the "Active quote chip" app embed on, My Quotes added to the account menu, Render web service reachable).

```bash
pnpm -F e2e test:pw:install                 # chromium
export E2E_STORE_URL=https://<dev-store>.myshopify.com
export E2E_STORE_PASSWORD=...               # only if the storefront is password protected
export E2E_PRODUCT_PATH=/products/<handle>  # a product with a quotable variant
export E2E_MY_QUOTES_PATH=/account/extensions/my-quotes   # confirm the real path in the dev store
export E2E_ADMIN_APP_URL=https://admin.shopify.com/store/<dev-store>/apps/dsg-quotes
pnpm -F e2e test:pw
```

Saving logins (customer accounts use one-time email codes and the admin needs MFA, so logins cannot be scripted):

```bash
cd tests/e2e
npx playwright codegen --save-storage=.auth/dealer-a.json  $E2E_STORE_URL/account   # Acme dealer 1; log in, close the window
npx playwright codegen --save-storage=.auth/dealer-b.json  $E2E_STORE_URL/account   # Acme dealer 2
npx playwright codegen --save-storage=.auth/dealer-c.json  $E2E_STORE_URL/account   # Other Co dealer
npx playwright codegen --save-storage=.auth/rep.json       https://admin.shopify.com  # rep
npx playwright codegen --save-storage=.auth/manager.json   https://admin.shopify.com  # manager
```
Override paths with `E2E_DEALER_A_STATE`, `E2E_DEALER_B_STATE`, `E2E_DEALER_C_STATE`, `E2E_REP_STATE`, `E2E_MANAGER_STATE`. `.auth/` is git-ignored.

Seeding the dev store: the specs expect quotes whose titles start with `E2E` in known states (`E2E multi-version` with two sent versions, `E2E ready to accept`,
`E2E expired`, `E2E claim me` SUBMITTED, `E2E below floor` SUBMITTED with a thin-margin line, `E2E changes requested`, plus an Acme-only quote the Other Co dealer must not see).
Create them with `pnpm -F api db:seed`-style scripts against the dev database or by hand; staff internal notes must contain the text `E2E-INTERNAL` so the specs can prove it never reaches a dealer.
The seeding helper is the first thing to add once the store exists (reuse `api/support/flows.ts` against the live API with real tokens).

| Spec | Screens |
| --- | --- |
| `storefront-blocks.spec.ts` | 1 (Add to Quote, popover a11y, new quote, existing draft, logged-out) and 2 (Move cart to quote: draft, submit, validation, cart cleared only after 2xx) |
| `my-quotes.spec.ts` | 3 (list, chips, search, row actions, delete draft, cross-company), 4 (versions, highlight changes, request changes, accept, Buy now, expired, no internal notes), 5 (notification matrix, SMS consent) |
| `admin-editor.spec.ts` | 6 (inbox tiles, tabs, filters) and 7 (claim, reprice, internal note vs customer message, preview as customer, send, floor approval as manager, change-request callout) |
| `a11y.spec.ts` | axe (wcag2a/2aa/21a/21aa) on screens 1-7, zero serious or critical violations |

Network privacy on live pages: `captureCustomerTraffic()` in `playwright/support/helpers.ts` records every `/apps/quotes/*` and `/c/*` response and fails on cost, margin or internal keys.

Known gaps in this layer: the full pay step of Shopify checkout and the resulting `orders/create` webhook cannot be automated without a payment gateway;
verify ORDERED live by completing the draft order from the admin (net-terms location) and re-running the API layer's `orders/create` test shape. Selectors are
unverified against the real DOM (Polaris web components render inside Shopify's sandbox); expect a first pass of fixes. Typecheck with `pnpm -F e2e typecheck:pw` after installing Playwright.

## CI (for the lead)

Run layer 1 on every PR touching `apps/api` or `packages/shared` (needs a Postgres service; set `E2E_DATABASE_URL`). Run layer 2 nightly once the dev store exists,
with `E2E_*` secrets and fresh `.auth` files; post the summary to the PR.
