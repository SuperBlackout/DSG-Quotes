# apps/api

Owner: **backend agent**. See `docs/AGENTS.md` and `docs/ISSUES.md` (ISSUE-1).

REST API for DSG Quotes, implementing `docs/openapi.yaml`: customer `/c/*`, staff `/s/*`, Shopify webhooks.

**Architecture decision:** a standalone **Fastify 5** service (not mounted inside the React Router admin app). It owns
raw-body webhook verification, its own test harness and lifecycle; Render runs it as `dsg-quotes-web` with
`pnpm -F api start`. The admin app calls it at `/api/s/*` (same routes also at `/s/*`). Prisma 6 uses the Rust-free
query compiler + `@prisma/adapter-pg` (`engineType = "client"`), so no engine binaries are needed at runtime.

## Run

```bash
cp ../../.env.example .env            # needs DATABASE_URL, SHOP_DOMAIN, SHOPIFY_API_KEY, SHOPIFY_API_SECRET
pnpm -F api prisma migrate deploy     # applies prisma/migrations (hand-maintained SQL, see below)
pnpm -F api db:seed -- --reset        # optional demo data: 3 companies, 12 quotes, all 10 statuses (fake data only)
pnpm -F api start                     # listens on $PORT (default 3000); GET /healthz
```

Mounts: `/c/*` and `/proxy/c/*` (app proxy forwards `/apps/quotes/*` to `<APP_URL>/proxy/*`), `/s/*` and `/api/s/*`,
`POST /webhooks/shopify` (set `uri = "/webhooks/shopify"` for every topic in `shopify.app.toml`).

## Auth (all verified in `src/auth`, unit-tested with fake secrets)

| Caller | Credential | Result |
| --- | --- | --- |
| Storefront blocks (`/c`) | App proxy query signature (HMAC-SHA256 hex, 5 min window, `shop` must match) | customer = `logged_in_customer_id` |
| My Quotes extension (`/c`) | `Authorization: Bearer` customer-account session token (HS256, `aud`=client id, `dest`=shop, `sub`=customer GID) | customer = `sub` |
| Admin app (`/s`) | `Authorization: Bearer` admin session token (same verification, `sub` = staff user id) | Staff row, auto-provisioned |
| Shopify webhooks | `X-Shopify-Hmac-Sha256` over the raw body, dedupe by `X-Shopify-Webhook-Id` | |

The customer is resolved to a company buyer through the `ShopifyGateway`; every `/c` query is scoped to the buyer's
`companyLocationId` (cross-company or cross-location = 404). `X-Company-Location-Id` may select among the contact's own
locations. `/c` sends permissive CORS headers (Bearer token, no cookies) for the customer-account sandbox.

## Layout

- `src/shopify/` all Shopify access: `types.ts` (the `ShopifyGateway` interface), `fake.ts` (tests/dev), `real.ts`
  (Admin GraphQL, unverified), `graphql.ts` (every document), `validate.ts`.
- `src/domain/transitions.ts` the ONLY writer of `Quote.status` (`transition()` + one `events` row, in the caller's transaction;
  `test/integrity.test.ts` greps for violations). `checkout.ts` accept -> buy. `staffQuotes.ts` send/floor/draft revisions.
- `src/serializers/` whitelist serializers. `customer.ts` never emits cost, margin, floor flags, internal notes/messages.
- `src/routes/` `customer.ts`, `customerPrefs.ts`, `staff.ts`, `webhooks.ts`.

## Behaviour notes

- Lines live in three sets (`QuoteLine.set`): `CUSTOMER` (their draft / submitted request), `STAFF` (rep working revision,
  materialised on submit), `VERSION` (frozen). Customers only ever see CUSTOMER lines or the latest sent VERSION.
- Prices are snapshotted on add (`listPrice = quotedPrice =` buyer's contextual price, `cost` = inventory unit cost).
- Floor: a line is below the floor when `(quoted - cost)/quoted < priceFloorPct` of the quote's assigned rep (sender if unassigned;
  default 15). Unknown cost is not judged. Manager `approve-floor` approves one price/qty; editing the line resets the approval.
- Send: totals `subtotal = sum(qty*quoted)`, `discountTotal = sum(qty*max(list-quoted,0))` (informational), `total = subtotal + freight`;
  expiry = rep-chosen date or now + 14 days (`QUOTE_DEFAULT_EXPIRY_DAYS`).
- Checkout: row-locked, idempotent, draft order built from the frozen version at `quotedPrice`; net-terms locations are completed with payment pending.
- Internal notes never create events, so the worker cannot notify customers about them.

## graphql:validate

```bash
# 1. download the Admin GraphQL schema for ADMIN_API_VERSION (introspection JSON or SDL) - not committed
# 2.
SHOPIFY_SCHEMA_PATH=/path/to/admin-2026-07.json pnpm -F api graphql:validate
```
Exits 2 when the schema is missing (so "not run" can never look like "passed"), 1 when a document is invalid. **Not yet run
against the real schema** - none was available when this was written.

## Tests

`pnpm -F api test` runs against a real, throwaway Postgres and applies the same `migration.sql` files production uses.

```bash
# any empty Postgres 16, e.g. a second local cluster; the database is WIPED on every run
export TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5433/dsg_test   # this is also the default
pnpm -F api test
```
`test/zz-route-coverage.test.ts` fails if any route lacks a passing test or an error-path test, or drifts from `docs/openapi.yaml`;
every response in every test is validated against the contract (`test/openapi.ts`).

## Migrations

`prisma/migrations/*/migration.sql` is hand-maintained SQL in Prisma's format (the schema-engine binary could not be downloaded
in the build sandbox). `test/schema-sync.test.ts` fails on any drift from `schema.prisma`. When you can run Prisma normally,
`prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script` should print an empty migration.
In a sandbox without access to binaries.prisma.sh, `prisma generate` needs `PRISMA_SCHEMA_ENGINE_BINARY=/bin/true`.
