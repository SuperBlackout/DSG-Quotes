# apps/worker

Owner: **notifications agent**. See `docs/AGENTS.md` (section 5) and `docs/ISSUES.md` (ISSUE-5).

Render background worker (`pnpm -F worker start`), hourly cron (`pnpm -F worker cron`) and `pnpm -F worker build` (typecheck; code runs through tsx like the API).
Inbound webhooks live in `apps/api/src/hooks/` (mounted in `apps/api/src/app.ts`) and share the pure helpers in `src/lib/` and `src/inbound.ts`.

## How it works

- **Queue** = the `events` table. `processBatch` reads rows with `notifiedAt IS NULL`; each is processed in its own transaction that takes a
  per-quote advisory try-lock and `SELECT ... FOR UPDATE SKIP LOCKED` on the row, so concurrent workers never double-send (tested).
  Transient provider failures retry with exponential backoff (`payload._notify`: attempts, already-sent recipients, next attempt).
- **Who**: audience from the shared `NOTIFY` map (+ NEW_MESSAGE by author side, EXPIRING, the customer "received" confirmation on SUBMIT, and `FLOOR_APPROVAL_REQUESTED`).
  Customer events map to the seven preference keys: SUBMIT -> QUOTE_RECEIVED, SEND_REVISION -> QUOTE_READY, staff message -> NEW_MESSAGE, EXPIRING/EXPIRE -> EXPIRING,
  ORDER_PLACED -> ORDERED, ACCEPT -> ACCEPTED (WEEKLY_SUMMARY is the Monday cron). REQUEST_CHANGES goes to sales only (no customer key).
  Sales = assigned active rep, else the quote's team (`TeamMember`), else active `manager`/`admin` staff, else `SALES_NOTIFY_EMAIL`.
  `FLOOR_APPROVAL_REQUESTED` (payload lineIds, costUnknownLineIds, note, requester) goes to active managers/admins (requester excluded), never to customers or the rep.
  Customer = owner joined with `NotificationPref` (defaults: email on, SMS off). SMS only when the pref row has `sms`, `smsOptInAt` and a valid phone AND the number is not in `SmsOptOut`.
- **Watchers** (`CustomerProfile.watchers`, objects `{email,name,role,scope,channels}`; `Quote.watchers` stay plain emails): a watcher gets customer-facing alerts when the owner has the
  event on (email or SMS), the quote matches their `scope` (`all`, or the quote's job id) and their `channels.email` is on. A watcher's SMS needs their own opt-in; the contract stores no
  number or consent for a watcher, so texts to watchers are never sent (logged only).
- **STOP / START**: STOP writes `SmsOptOut` (source `twilio-stop` / `twilio-21610`), clears consent on the pref rows and logs `OPTED_OUT`. The sender checks `SmsOptOut` before every text, so
  re-saving the settings (which stamps a fresh `smsOptInAt`) does not re-consent. Only an explicit START text removes the row (`OPTED_IN_START` logged); the customer must then opt in again.
  The API's PUT /c/notification-prefs can use `isSmsOptedOut()` from `src/inbound.ts` to refuse `smsOptIn` for a blocked number.
- **Reply-To**: `q-<quoteId>-<c|s><hmac>@reply.dsg.direct`; the inbound hook verifies it, so replies land in the right quote on the right side.
- **Cron** (`runCron`): every run expires due quotes via the API's `applyTransition` (shared `transition()` + events row); the first run at/after 08:00 ET each
  day queues `EXPIRING` events for quotes expiring within 3 days and sends the rep digest (once-a-day markers in `Counter`); on Mondays the same gate also sends the
  customers' WEEKLY_SUMMARY email (open quotes: submitted, in review, changes requested, quote ready, accepted; not drafts or expired; default on; watchers get their scope).

## Env (all in render.yaml's shared group unless marked)

`DATABASE_URL, SHOP_DOMAIN, SHOPIFY_API_SECRET, APP_PUBLIC_URL, POSTMARK_SERVER_TOKEN, POSTMARK_INBOUND_TOKEN, EMAIL_FROM, EMAIL_REPLY_DOMAIN, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID`.
Optional (new): `REPLY_TOKEN_SECRET` (defaults to SHOPIFY_API_SECRET; must match between web and worker), `SALES_NOTIFY_EMAIL`, `ADMIN_QUOTE_URL`, `SUPPORT_EMAIL`, `SUPPORT_PHONE`,
`TWILIO_WEBHOOK_URL` (exact URL Twilio calls, if proxying changes it), `WORKER_POLL_MS`.
Without Postmark credentials: dev prints emails, production refuses to start. Without Twilio credentials the SMS channel is disabled (logged as skipped).

## Tests

`pnpm -F worker test` uses the real local Postgres (`TEST_DATABASE_URL`, default `postgresql://postgres@127.0.0.1:5433/dsg_test`) but its own database
`<name>_worker`, created on demand, so it can run alongside the API tests. Provider HTTP is exercised with a fake `fetch` only.
