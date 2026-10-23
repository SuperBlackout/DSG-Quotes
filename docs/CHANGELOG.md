# Changelog

Newest first. Every PR adds a line. Lead writes a gate report at each phase gate.

## 2026-10-23
- Account pages on the storefront: `/pages/statement` and `/pages/account-info` in the dsg.direct theme (`theme-overrides/assets/dsg-account-pages.js`), same data and rules as the customer-account pages. New app-proxy mount `/proxy/a/*` (Shopify's signed `logged_in_customer_id` -> same company / Location admin / account_map checks via `BuyerResolver.resolveCustomer`); session tokens are not accepted there and proxy signatures are not accepted on `/a`. CLAUDE.md rule 9 now names both credentials.
- Storefront theme: quote notification settings now live on the main site at `/pages/quote?tab=notifications` (new `theme-overrides/assets/dsg-quote-notifications.js`, tabs on the quotes page), same data and consent wording as the customer-account page. Review theme only; add the account-menu link after the theme is published.
- Storefront theme: polished `/pages/quote` (`theme-overrides/assets/dsg-quotes-page.js`). Next-step banner with Accept / Buy button, status colors, de-duplicated product names, mobile card layout with field labels, friendlier empty state, "Send to DSG" button. Uploaded to the review theme only.
- Storefront: redesigned the cart "Move cart to quote" block. Full-width two-column card, required-field marker with inline error, cart item count and total, "what happens next" steps, "Send to sales" / "Save as draft" buttons, clearer success state, and "View quote" now opens `/pages/quote?id=` by default. Size budget raised to 34 KB.
- Account pages: **Account statement** and **Account info** customer-account extensions moved into this app from the standalone `dsg-account` app (Zoho Books read-only cache, session-token identity, single-use PDF links), served by `dsg-quotes-web` under `/a` and `POST /webhooks/zoho`, nightly sync in `dsg-quotes-cron`. Off until the four `ZOHO_*` credentials are set. New packages `contracts`, `zoho`, `statement`, `identity`, `testkit`, `account-client`; migration `20261023000000_statement_tables`; `pnpm -F api add-mapping`. See `docs/ACCOUNT-PAGES.md`.

## 2026-10-22
- Storefront: "Add to Quote" buttons now feed the real quote module; /pages/quote is a themed list + quote detail (theme-overrides/). Built in a review copy of the theme, not yet published.
- Worker/cron: `EMAIL_LOG_ONLY=1` lets production start with emails printed to the log (no Postmark yet). Without it a missing token is still fatal.
- Admin: fixed Settings crash ("reading value of null") by reading input values before state updaters run.
- Admin editor: price/qty fields no longer reformat while typing (typing "2" no longer jumps to "2.00" with the cursor at the end).
- Settings: "Copy all quote alerts to" address (ShopSetting.copyAllAlertsTo). Every staff alert is CC'd to it; when no recipient has a real email, it is sent to that address alone. Placeholder `@users.invalid` staff emails count as no email.
- Reps can edit, price and send a DRAFT quote (DRAFT added to working statuses; staff working set is seeded from the customer's lines on first save).

## Unreleased

### Contract revision 0.2.0 (lead)
Applies the requests recorded by the four builders. Code follow-ups per folder: `docs/CONTRACT-FOLLOWUPS.md` (api 21, worker 6, app 14, quote-blocks 5, my-quotes 13, e2e 6). `packages/shared/src/api.ts` regenerated; 431 shared tests pass (new: `revision-*.test.ts`, including a guard against malformed schema keys).
- Breaking vs 0.1.0: `NotificationPrefs.events` is now exactly the seven keys (`CHANGES_REQUESTED` removed, `QUOTE_RECEIVED` and `WEEKLY_SUMMARY` added) and `NotificationPrefs.watchers` is `Watcher[]` instead of emails; new required fields `CustomerQuoteSummary.unreadCount` / `currencyCode`, `CustomerQuoteActions.canEditHeader`, `StaffQuoteSummary.itemCount` / `currencyCode`, `StaffSummary.tabCounts`.
- Decisions: (1) no `/s/variants/{id}`; `draft-revision` snapshots list price and cost for new variants. (2) A line with unknown cost (`costUnknown`) always needs manager floor approval before send. (3) Next version is `max(currentVersion, highest versions[].versionNo) + 1`, exposed as `nextVersionNo`. (4) Money stays a string; currency is `currencyCode` on the quote. (5) Quote-level `watchers` stay email strings; rich watchers live in notification prefs. (6) Rate limiting deferred.
- Docs: `docs/SETUP.md` (My Quotes menu entry added by hand, network access approval, Terms/Privacy URL check); `.env.example` gains `ATTACHMENTS_REGION`, `ATTACHMENTS_PUBLIC_BASE_URL`, `QUOTE_DEFAULT_EXPIRY_DAYS`, `SIGNATURE_MAX_AGE_SECONDS`.

### Backend requests applied (contract 0.2.0)
- `POST /webhooks/shopify` documented (HMAC, topic dispatch, idempotent on webhook id); `StaffQuote.workingExpiresAt`; unknown-cost lines require manager approval (`costUnknown`); `lineNote` customer-visible vs `internalNote` private; `/hooks/email-inbound` and `/hooks/twilio-inbound` served from `apps/api`, owned by notifications; new env vars; rate limiting deferred. Follow-ups API-1..21.

### Storefront requests applied (contract 0.2.0)
- `from-cart` existing mode carries `poNumber`, `neededBy`, `notesToSales`; `emptyCart` informational; `PUT /c/active-quote` after saving a draft; drafts listed with `limit` up to 100. Follow-ups SF-1..5.

### Customer-account requests applied (contract 0.2.0)
- `/c/*` also on `https://quotes.dsg.direct` (servers entry, CORS incl. `null` origin, `Authorization`, OPTIONS preflight, session token auth); `assignedRepName`, `unreadCount`, `previousTotal`, `currencyCode` on summaries; `canEditHeader`; seven notification event keys; richer watchers; `GET /c/quotes/{id}/pdf`; `NOT_PURCHASABLE` -> "Ask for a new quote", `VERSION_MISMATCH` -> re-review. Follow-ups CA-1..13.

### Admin requests applied (contract 0.2.0)
- `GET /s/me`; `GET /s/staff`, `PUT /s/staff/{id}`; `/s/teams` CRUD; `GET/PUT /s/settings`; `GET/PUT /s/saved-replies`; `POST /s/quotes/{id}/request-floor-approval`; inbox `rep=me|unassigned`, `Q-#####` search, `tabCounts`, `itemCount`; `GET /s/customers?q=`; `paymentTerms`, customer contact name/phone on `StaffQuote`; `POST /s/quotes/{id}/attachments/upload-url`; Send vN rule. Follow-ups ADM-1..14.

### Theme extension layout fix
- Shopify theme app extensions may only contain assets, blocks, locales and snippets. Tests, package.json and README moved to `tests/quote-blocks/` (package `quote-blocks-tests`); added `locales/en.default.json`. Found by the first `shopify app deploy`.

### Worker, notifications, e2e (contract 0.2.0 follow-up)
- api: contract 0.2.0 (staff roles/teams/settings/saved replies, routing, floor-approval request, PDF, CORS/auth split), four QA bug fixes with regression tests, NotificationLog and SmsOptOut tables; settings refuse SMS opt-in for a number that sent STOP.
- worker: seven pref keys, role/team recipients, per-watcher scope/channels, Monday weekly summary, FLOOR_APPROVAL_REQUESTED to managers, send log in NotificationLog, STOP history in SmsOptOut.
- e2e: fixtures adapted (roles, auth split, unknown-cost approval), known-bug tests flipped to normal, new staff-admin/customer/PDF flows. Run with its own `E2E_DATABASE_URL`.
- Test counts: shared 431, api 268, worker 94, app 85, my-quotes 151 (+7 skipped), quote-blocks 29, e2e 163.
- Unverified live: Shopify GraphQL docs added for customer/contact search, Postmark, Twilio, S3, PDF link in customer account, CORS from the null origin.

### Phase 1 Foundation (lead scaffold)
- pnpm workspace (`packages/shared`, `apps/api`, `apps/worker`, `tests/e2e`, `app`, `extensions/*`), strict `tsconfig.base.json`.
- `docs/openapi.yaml` v0.1.0: customer (`/c`) and staff (`/s`) routes, `{code,message}` errors, webhooks. Customer schemas contain no cost, margin or internal notes (enforced by `packages/shared/test/openapi-contract.test.ts`).
- Types generated to `packages/shared/src/api.ts` (`pnpm -F shared gen:types`); Prism mock via `pnpm -F shared mock`.
- State machine: 386 exhaustive tests (10 statuses x 11 events x 3 actors, isPurchasable, customerCanEditLines, waitingOn).
- **Fix** `quote-state.ts`: `transition()`/`canTransition()` resolved inherited keys such as `"toString"` or `"constructor"` as rules (TypeError instead of `TransitionError`). Now own-property lookups; `TransitionError.name` set.
- `ADMIN_API_VERSION = "2026-07"` in `packages/shared/src/shopify.ts` (to be confirmed against shopify.dev).
- `render.yaml` (web, worker, cron, Postgres) and `.env.example`.
- `docs/SETUP.md` manual steps; `docs/ISSUES.md` builder issues.
- Open: gate "Render services up" and "Twilio A2P + email domain started" wait on `docs/SETUP.md` steps 4-6.
- Staff may SEND_REVISION from DRAFT so rep-created quotes can be priced and sent (previously the editor was read-only).
- Admin quote editor: Add product button moved inline (the section slot wasn't rendered).
- Fix: customer-account session tokens (bare shop in dest, no iss) are now accepted; they were rejected as expired.
- Cart block styling: fixed oversized inputs, page-width container, light card and a visible primary button.

- Worker: daily rep digest skips staff with placeholder (`@users.invalid`) emails instead of failing the cron run.
- Worker: optional `CUSTOMER_QUOTE_PAGE_URL` (e.g. https://dsg.direct/pages/quote) makes dealer email links open the on-site quote page (`?id=`). Staff links use `ADMIN_QUOTE_URL` (set to the admin.shopify.com app URL; the old default 404'd).
- Admin: rep message box has Email / Text checkboxes (default both) to choose how a customer message notifies; API `POST /s/quotes/{id}/messages` takes optional `channels`, worker honors it (customer's own settings still apply).
- Admin: Conversation panel moved from the page aside into a full-width section under Notes so it is never clipped off-screen.
- Per-quote notifications: new "Notifications for this quote" section in the rep app shows who gets alerts, lets reps add extra emails or mobile numbers for that one quote, and lists recent sends. Extra numbers get a one-time confirmation text and are only texted after the person replies YES (STOP removes them; replies join the quote thread). New `QuoteRecipient` table (migration 20261024000000), endpoints `GET /s/quotes/{id}/notifications`, `POST/DELETE /s/quotes/{id}/notification-recipients[/{rid}]`, `POST .../resend`; erased on customer/shop redact.
- SMS welcome: each time a number newly enrolls in texts (settings opt-in, or YES to a per-quote confirmation) it gets "DSG Distributors LLC: You've successfully enrolled in SMS notifications…" once; re-enrolling after STOP sends it again. Worker `sendWelcomeTexts`; logged as WELCOME_SENT / WELCOME_FAILED.
