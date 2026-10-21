# Changelog

Newest first. Every PR adds a line. Lead writes a gate report at each phase gate.

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
