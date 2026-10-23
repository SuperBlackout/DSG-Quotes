# Account pages: Account statement + Account info

Two full-page customer-account extensions, built into this app so dealers get everything (quotes, statement, company details)
from one place on dsg.direct. They replace the standalone `dsg-account` / "DSG Account Statement" app; the code was moved here with
its security model and tests intact.

| Page | Extension | Shows | Data from |
| --- | --- | --- | --- |
| Account statement | `extensions/account-statement` | Outstanding, overdue, unused credits, credit limit, terms; activity (invoices, payments, credit notes, sales orders) with search and filters; single-use statement and invoice PDFs | Zoho Books (read-only), cached in Postgres |
| Account info | `extensions/account-info` | Company name and customer number, payment terms, credit limit, currency, locations with billing and shipping addresses, contacts with roles | Shopify Admin API (company profile) + the cached Zoho contact |

Shared pieces: `packages/account-client` (API client, formatters), `packages/contracts` (zod response shapes), `packages/zoho`
(read-only Zoho client), `packages/statement` (cache, sync, PDF links, mapping admin), `packages/identity` (session token to company).

## How it works

```
customer account page --(Bearer session token)--> /a/v1/*  (dsg-quotes-web)
                                                    |  verify token -> Shopify customer -> company
                                                    |  company -> account_map -> Zoho customer
                                                    v
                         Postgres cache (zoho_*)  <--  sync: Zoho webhook (debounced) + nightly 3:00 ET (cron)
```

- Routes (`apps/api/src/statement/routes.ts`): `GET /a/v1/statement/summary`, `GET /a/v1/statement/activity`, `POST /a/v1/statement/pdf-link`,
  `POST /a/v1/invoices/:id/pdf-link`, `GET /a/v1/account`, `GET /a/files/:token` (single-use PDF), `POST /webhooks/zoho`.
  They are **not** part of `docs/openapi.yaml` (that contract covers `/c` and `/s`) and have their own `{ "error": "<generic>" }` error shape; the
  extensions map by status code only.
- **Feature switch.** The routes exist only when all four `ZOHO_*` credentials are set. With none set the API behaves exactly as before; a partial set
  stops startup with a clear message. The cron's statement sync follows the same switch.
- **Who can see what.** The only identity is the verified customer-account session token. The API loads that customer's single company profile from
  Shopify, requires the **Location admin** role, looks the company up in `account_map` (active rows only) and requires the company's Shopify
  `externalId` to equal the mapped customer number. Nothing in the query, body, params or headers chooses whose data is returned; every query is
  scoped by `zoho_customer_id`. A contact in two companies, a plain member, an unmapped company and a deactivated mapping all get 403 (audited).
- **Account info reads the company from the token, not the request.** It is a live Admin API read (about one query per page view); the Zoho fields
  come from the cache and are empty until the first sync.
- **Zoho is read-only.** Never add a Zoho write call or a non-READ scope (`packages/zoho` enforces GET at the client).
- **Money** is a 2-place decimal string end to end.
- **Syncs.** A Zoho webhook (HMAC) queues a debounced re-sync of that one customer inside the web process. The hourly cron (`dsg-quotes-cron`) runs a
  full re-sync of every linked account once a day from 3:00 America/New_York (marker `cron:statement-sync:<date>` in `Counter`; if every account fails the
  marker is released so the next hour retries). Zoho returning no documents never wipes an existing cache unless forced.
- **Safety nets kept from the standalone app.** A mapping whose Zoho contact number no longer matches is deactivated at sync time and nothing is cached;
  draft and void documents are never shown; PDF links are single use, expire in 5 minutes, and are handed back if Zoho fails; per-customer rate limit
  of 60 requests a minute.

## Storefront pages (`/pages/statement`, `/pages/account-info`)

The same two pages are also available as normal pages in the dsg.direct theme, like `/pages/quote`, so dealers need not open the separate
customer-account area. `theme-overrides/assets/dsg-account-pages.js` (one script, two views) calls the same routes through the Shopify app proxy:

```
theme page --(/apps/quotes/a/v1/*, signed by Shopify)--> /proxy/a/v1/*  (same handlers as /a/v1/*)
```

- **Identity on this mount** is only Shopify's app proxy HMAC (shop, timestamp freshness) plus the signed `logged_in_customer_id`. It goes through
  `BuyerResolver.resolveCustomer`, which applies the identical company / Location admin / `account_map` / customer-number checks. The browser never
  chooses the customer; a changed or extra query value breaks the signature. A session token is not accepted on `/proxy/a`, and a proxy signature is not
  accepted on `/a`. No CORS headers on `/proxy/a`.
- `/proxy/a` has no `/files/:token`: PDF links returned there point at `/a/files/<token>` (single use, 5 minutes), which opens as a normal page navigation.
- Setup in Shopify (theme upload, two pages, menu links) is in `docs/SETUP.md` section 9 and `theme-overrides/README.md`.

## Database

`apps/api/prisma/migrations/20261023000000_statement_tables` creates `account_map`, `zoho_contact`, `zoho_document`, `pdf_link`, `sync_event`,
`access_audit`. They are plain SQL tables used through `pg` by `packages/statement` (not Prisma models); `packages/statement/migrations/001_statement_tables.sql`
is the single source and a test fails if the Prisma migration drifts from it.

## Go-live checklist

1. **Zoho credentials.** In the Zoho API console create a dedicated *Self Client* (not a person's token) in the right data centre. Generate the grant
   with exactly `ZohoBooks.contacts.READ,ZohoBooks.invoices.READ,ZohoBooks.customerpayments.READ,ZohoBooks.creditnotes.READ,ZohoBooks.salesorders.READ`
   and nothing else. Put `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_ORG_ID` (and `ZOHO_API_BASE` / `ZOHO_ACCOUNTS_BASE` if not US) in the
   Render env group `dsg-quotes-zoho`. Confirm a write is rejected by Zoho. `scripts/` from the old repo (`zoho-setup.mjs`, `zoho-check.mjs`) can generate the refresh token.
2. **Env.** `ZOHO_WEBHOOK_SECRET` (any long random string; configure the same value in the Zoho webhook), optionally `STATEMENT_PUBLIC_BASE_URL`
   (defaults to `SHOPIFY_APP_URL`). The Shopify scopes `read_customers,read_companies` are already in `SCOPES`.
3. **Deploy.** Deploy `dsg-quotes-web` (the migration runs in the pre-deploy step) and `dsg-quotes-cron`. Check the web log line
   `account pages enabled (/a)` and `GET /healthz`.
4. **Link each dealer.** In a Render shell on `dsg-quotes-web`:
   `pnpm -F api add-mapping gid://shopify/Company/<id> <CUS-number>`. It looks the customer number up in Zoho and refuses unless exactly that customer exists.
   Make sure each Shopify company's **External ID** equals the Zoho Customer Number. Pilot: Pure Vision (`gid://shopify/Company/8498708779`, CUS-1048) and
   Digital Sales Group Metro LLC (`gid://shopify/Company/8513159467`, CUS-1626).
5. **First sync.** The first sync happens at the next webhook or the 3:00 ET run; until then the statement page answers 503 ("temporarily unavailable") and queues a sync
   itself, so reloading after a minute or so works. To sync immediately run a one-off `syncCustomer` from a Render shell or restart the web service and open the page once.
6. **Ship the extensions.** `shopify app deploy` (lead only). Then in the Dev Dashboard approve **network access** for both new extensions, and add both pages
   to the customer account menu by hand (Settings > Checkout > Customize > Customer accounts > Menu), like My Quotes. The extensions default to
   `https://quotes.dsg.direct`; until that domain exists set the **Quotes API base URL** setting on each extension to the onrender.com address.
7. **Retire the standalone app.** Uninstall "DSG Account Statement" (or remove its extension) so customers do not see two "Account statement" entries, and stop its Render services.
8. **Test as a buyer** from each pilot company (role Location admin): summary, filters, both PDFs (the "Open PDF" link), the Account page; and confirm a buyer from one
   company cannot see the other's data.

## Not yet verified (needs the live systems)

- Nothing has run in a real customer-account preview. Unverified UI details: `<s-banner dismissible onDismiss>`, `<s-link target="_blank">` from the sandbox,
  `<s-date-field>` / `<s-select>` event shapes, `shopify.sessionToken.get()`, `shopify.settings.value.api_base_url`, and network-access approval.
- Zoho assumptions from the standalone app still apply: statement PDF covers the displayed range; customer number is `contact_number`; status strings other than
  draft/void are shown as-is; single currency (USD) per dealer; "today" for overdue is the UTC date. See the old `HANDOVER.md` for the full list.
- The Account page's company query (`ACCOUNT_INFO`) and the buyer lookup (`ACCOUNT_RESOLVE_BUYER`) were checked field by field against the 2026-07 Admin schema,
  but `pnpm -F api graphql:validate` (full-document validation) still needs a downloaded schema file.
- Role rule is a string match on "Location admin"; the identity lookup is cached for 60 s, so a revoked role can lag by that long.
- Staff mapping admin is the CLI only. The standalone app's `/admin` HTML screen (header-secret auth, a placeholder) was deliberately not carried over; add a
  staff route behind the existing Shopify admin session auth if a screen is wanted.
