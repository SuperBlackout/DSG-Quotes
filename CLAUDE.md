# DSG Quotes — Shopify quoting app

Custom Shopify app for dsg.direct (DSG Distributors). Dealers build quotes from the storefront, sales reps
reprice and reply in the Shopify admin, and only an **Accepted** quote can be bought (converted to a
Shopify draft order with locked prices).

Plan, mockups and workflow: see `docs/PLAN.md`.

## Repo layout (each agent owns one folder — do not edit folders you don't own)

| Folder | Owner agent | What lives here |
| --- | --- | --- |
| `docs/`, `packages/shared/` | lead | Plan, API contract (`docs/openapi.yaml`), shared types, quote state machine |
| `apps/api/` | backend | REST API (proxy + admin routes), Prisma schema, Shopify Admin GraphQL client, webhooks |
| `apps/worker/` | notifications | Event queue consumer, email + SMS senders, inbound reply webhooks, cron jobs |
| `app/` | admin | Embedded admin app (Shopify React Router template + Polaris web components): inbox, editor |
| `extensions/quote-blocks/` | storefront | Theme app extension: Add to Quote, Move cart to quote, active-quote chip |
| `extensions/my-quotes/` | customer-account | Customer account full-page extension (`customer-account.page.render`) |
| `apps/api/src/statement/`, `packages/{contracts,zoho,statement,identity,testkit,account-client}/`, `extensions/account-statement/`, `extensions/account-info/` | account-pages | Customer-account Statement + Account info pages over Zoho Books (read-only). Routes under `/a`, outside `docs/openapi.yaml`. See `docs/ACCOUNT-PAGES.md` |
| `tests/e2e/` | qa | Playwright end-to-end flows against the dev store, contract tests, fixtures |

## Stack

- Node 20 + TypeScript (strict), pnpm workspaces
- Shopify CLI app (`shopify.app.toml`), Admin GraphQL API version pinned in `packages/shared/src/shopify.ts`
- Postgres on Render, Prisma ORM
- Render: `dsg-quotes-web` (API + admin app), `dsg-quotes-worker` (background worker), `dsg-quotes-cron`
- Email: Postmark (or Resend) — outbound + inbound reply parsing
- SMS: Twilio Messaging Service registered under A2P 10DLC

## Commands

```bash
pnpm install
pnpm dev                    # shopify app dev (tunnels admin app + extensions to the dev store)
pnpm -F api prisma migrate dev
pnpm test                   # unit + contract tests, all packages
pnpm -F e2e test            # Playwright against the dev store
shopify app deploy          # ships extensions + app config (lead only, at phase gates)
```

## Non-negotiable rules

1. **Status changes go through `transition(quote, event, actor)`** in `packages/shared/src/quote-state.ts`.
   Never write `quote.status` directly. Every transition writes one row to `events`.
2. **Only `ACCEPTED` and not expired can be purchased.** The API re-checks this server-side before
   creating a draft order; never trust the client.
3. **Customer endpoints are scoped** to the logged-in customer's company location (app proxy signature
   or customer account session token). A customer can never read another company's quote.
4. **Cost and margin never leave staff routes.** `quote_lines.cost` is stripped from every customer
   response; a contract test enforces this.
5. **Internal messages (`internal = true`) are never returned to customers** and never trigger customer
   notifications.
6. **Prices are snapshotted** on the quote line when added; catalog changes don't move a quote.
7. **Validate every GraphQL operation** against the pinned schema before committing
   (`pnpm -F api graphql:validate`).
8. No real customer data or production keys in code, tests or fixtures. Use the dev store.
9. Account pages (`/a`): Zoho access is READ-ONLY (never add a Zoho write call or non-READ scope); a buyer is identified only by the verified session token on `/a`, or Shopify's signed app proxy `logged_in_customer_id` on `/proxy/a`, -> company -> `account_map` (never accept an unsigned customer id from the client); every statement query is scoped by `zoho_customer_id`.
10. Code only against `packages/shared` types and `docs/openapi.yaml`. Need a contract change? Open a
   PR touching only `docs/` / `packages/shared/` and tag the lead.

## Definition of done for every PR

- One feature, tests passing, typecheck clean
- UI changes include a screenshot or short GIF
- `docs/CHANGELOG.md` updated
- No TODOs touching auth, pricing or status logic
