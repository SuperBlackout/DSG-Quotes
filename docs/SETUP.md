# Manual setup (needs Shopify, Render, Twilio, DNS logins)

The lead scaffold deliberately does NOT run `shopify app init` (needs auth). Someone with the accounts
(Mike or the dev) runs these steps once, in order. Check each box when done and note dates in `docs/CHANGELOG.md`.

## 0. Local prerequisites
- [ ] Node 20+, pnpm 10 (`corepack enable`), Shopify CLI 3.x (`npm i -g @shopify/cli@latest`), Postgres 16 (or Docker).
- [ ] `git clone` this repo, `pnpm install`, `cp .env.example .env`.
- [ ] `pnpm -F shared test` should show all tests passing before you start.

## 1. Shopify Dev Dashboard app
- [ ] In the Shopify **Dev Dashboard** (dev.shopify.com) create an app named **DSG Quotes** under the DSG organization. Distribution: custom (single store / org).
- [ ] Copy Client ID and Client secret into `.env` (`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`) and later into Render.
- [ ] Confirm the Admin API version in `packages/shared/src/shopify.ts` (`2026-07`) is a stable release at https://shopify.dev/docs/api/usage/versioning. If not, change it in one place and rerun the tests.

## 2. Dev store
- [ ] Create a **development store** with Shopify Plus features (B2B / Companies) enabled (Dev Dashboard > Stores, "Plus sandbox"/dev store with B2B).
- [ ] Create 2 companies, each with a location, 3 dealer contacts, and a catalog with price lists. Create 2 staff accounts (rep) and 1 manager.
- [ ] Turn on **new customer accounts** (Settings > Customer accounts) so the My Quotes extension works.
- [ ] Add **My Quotes** to the customer account menu by hand: Shopify admin > Settings > Checkout (Customize) > **Customer accounts** > the **checkout and accounts editor** > Menu. A full-page customer account extension does not add itself to the menu, so it stays hidden until you add it here.
- [ ] Add ~20 products with cost per item set.

## 3. Scaffold the Shopify app (once, by one person)
Run from a scratch directory, then move the generated files into this repo; do not overwrite `packages/`, `apps/`, `docs/`, `CLAUDE.md`.
```bash
shopify app init --template=reactRouter --name dsg-quotes   # TypeScript, link to the Dev Dashboard app from step 1
```
- [ ] Move the generated app routes into `app/` (admin agent's folder) and `shopify.app.toml` to the repo root. Keep the root `package.json` workspace config; merge the template's dependencies into `app/package.json` (name it `app`).
- [ ] Replace Prisma/SQLite session storage with the schema in `apps/api/prisma/schema.prisma` (Postgres).
- [ ] Generate extensions:
  ```bash
  shopify app generate extension --template theme_app_extension --name quote-blocks     # -> extensions/quote-blocks
  shopify app generate extension --template customer_account_ui --name my-quotes       # -> extensions/my-quotes
  shopify app generate extension --template admin_action --name open-quote              # draft order details action
  ```
- [ ] In `shopify.app.toml` set scopes (must equal `APP_SCOPES` in `packages/shared/src/shopify.ts`):
  `read_customers, read_companies, read_products, read_inventory, read_orders, read_draft_orders, write_draft_orders`.
  Verify each scope name in the current docs; add any B2B scope the draft-order `purchasingEntity` call requires.
- [ ] Configure the app proxy: prefix `apps`, subpath `quotes`, proxy URL `<SHOPIFY_APP_URL>/proxy`.
- [ ] Subscribe webhooks in the toml: `orders/create`, `draft_orders/update`, `app/uninstalled`, and the mandatory compliance topics (`customers/data_request`, `customers/redact`, `shop/redact`).
- [ ] **Approve network access** for the My Quotes extension in the Dev Dashboard (app version > extension > Network access). The extension calls `https://quotes.dsg.direct/c/*` from the customer account sandbox; until network access is approved (and `network_access = true` is set in the extension toml) every call is blocked. The API must answer CORS preflights for the `null` origin (see `docs/openapi.yaml`).
- [ ] Protected customer data: request access in the Dev Dashboard (customer name/email/phone) if the app is not exempt.
- [ ] `shopify app dev`, install on the dev store, confirm the admin app loads.

## 4. Render
- [ ] Render dashboard > **New > Blueprint** > connect the GitHub repo > select `render.yaml` (creates `dsg-quotes-web`, `dsg-quotes-worker`, `dsg-quotes-cron`, `dsg-quotes-db`).
- [ ] Fill every `sync: false` variable in the `dsg-quotes-shared` env group. Set `SHOPIFY_APP_URL` to the web service URL, then update the app URL / redirect URLs / proxy URL in the Dev Dashboard.
- [ ] Add the custom domain (e.g. `quotes.dsg.direct`) to the web service; add the CNAME at the DNS host.
- [ ] Note: the web/worker/cron start commands (`pnpm -F api start`, `pnpm -F worker start|cron`, `/healthz`) are created by the backend and notifications agents. First deploy will fail until those scripts exist; leave auto-deploy off.

## 5. Twilio (start immediately, approval takes days to weeks)
- [ ] Create a Twilio account and upgrade it. Register the business in **Trust Hub** (Customer Profile).
- [ ] Register an **A2P 10DLC Brand** and **Campaign** (use case: Account notifications / Customer care). Provide the opt-in consent text used in the My Quotes notification page, sample messages, privacy policy and terms URLs.
- [ ] Confirm these URLs exist and load (open them in a browser) before submitting: Terms `https://dsg.direct/policies/terms-of-service` and Privacy `https://dsg.direct/policies/privacy-policy`. The path is `/policies/privacy-policy`, not `/privacy`. If either 404s, publish the policy in Shopify (Settings > Policies) first; a campaign with dead URLs is rejected.
- [ ] Buy a local number (or toll-free + verification), attach it to a **Messaging Service**, link the Campaign.
- [ ] Set the Messaging Service inbound webhook to `https://<web>/hooks/twilio-inbound`. Copy SID/token/Service SID to Render.
- [ ] Until approved, test SMS only to verified numbers.

## 6. Email domain (Postmark)
- [ ] Create a Postmark server `dsg-quotes`; add sender domain `dsg.direct` and add DKIM + Return-Path DNS records. Verify.
- [ ] Inbound: create the inbound domain `reply.dsg.direct` (MX record to `inbound.postmarkapp.com`); set the inbound webhook to `https://<web>/hooks/email-inbound` with basic auth token = `POSTMARK_INBOUND_TOKEN`.
- [ ] Add SPF/DMARC (`p=none` first) for `dsg.direct`. Create templates listed in the notifications issue.
- [ ] Resend can replace Postmark; if so, tell the lead before the notifications agent starts.

## 7. Attachments storage
- [ ] Create an S3-compatible bucket (private) with CORS allowing PUT from the storefront and customer-account origins; put credentials in Render.

## 8. Handoff checks
- [ ] `pnpm install && pnpm test` passes on a clean clone.
- [ ] `pnpm -F shared mock` serves the API on :4010 (send any `Authorization: Bearer mock` header; responses are random dynamic data, good enough to build UIs against).
- [ ] Tell the lead; the lead then unblocks the builder agents that need live credentials.
