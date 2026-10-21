# apps/worker

Owner: **notifications agent**. See `docs/AGENTS.md` (section 5) and `docs/ISSUES.md` (ISSUE-5).

Render background worker (`pnpm -F worker start`), hourly cron (`pnpm -F worker cron`) and `pnpm -F worker build` (typecheck; code runs through tsx like the API).
Inbound webhooks live in `apps/api/src/hooks/` (mounted in `apps/api/src/app.ts`) and share the pure helpers in `src/lib/` and `src/inbound.ts`.

## How it works

- **Queue** = the `events` table. `processBatch` reads rows with `notifiedAt IS NULL`; each is processed in its own transaction that takes a
  per-quote advisory try-lock and `SELECT ... FOR UPDATE SKIP LOCKED` on the row, so concurrent workers never double-send (tested).
  Transient provider failures retry with exponential backoff (`payload._notify`: attempts, already-sent recipients, next attempt).
- **Who**: audience from the shared `NOTIFY` map (+ NEW_MESSAGE by author side, EXPIRING, and the customer "received" confirmation on SUBMIT, per screen 5).
  Sales = assigned rep, else team, else managers, else `SALES_NOTIFY_EMAIL`. Customer = owner (+ watchers, email only) joined with `NotificationPref`
  (defaults: email on, SMS off). SMS only when the pref row has `sms`, `smsOptInAt` and a valid phone.
- **Quiet hours** defer SMS only: an `SMS_DEFERRED` event waits until the window ends; consent is re-checked before sending.
- **Bundling**: first NEW_MESSAGE alert goes out at once; later ones on the same quote/side within 5 minutes leave as one alert after the window.
- **Internal messages** never notify customers (filtered at the source, and again here).
- **Send log**: every send writes an `events` row `type = NOTIFICATION` (channel, to, status, providerId). No schema change was possible from this folder.
- **Reply-To**: `q-<quoteId>-<c|s><hmac>@reply.dsg.direct`; the inbound hook verifies it, so replies land in the right quote on the right side.
- **Cron** (`runCron`): every run expires due quotes via the API's `applyTransition` (shared `transition()` + events row); the first run at/after 08:00 ET each
  day queues `EXPIRING` events for quotes expiring within 3 days and sends the rep digest (once-a-day markers in `Counter`).

## Env (all in render.yaml's shared group unless marked)

`DATABASE_URL, SHOP_DOMAIN, SHOPIFY_API_SECRET, APP_PUBLIC_URL, POSTMARK_SERVER_TOKEN, POSTMARK_INBOUND_TOKEN, EMAIL_FROM, EMAIL_REPLY_DOMAIN, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID`.
Optional (new): `REPLY_TOKEN_SECRET` (defaults to SHOPIFY_API_SECRET; must match between web and worker), `SALES_NOTIFY_EMAIL`, `ADMIN_QUOTE_URL`, `SUPPORT_EMAIL`, `SUPPORT_PHONE`,
`TWILIO_WEBHOOK_URL` (exact URL Twilio calls, if proxying changes it), `WORKER_POLL_MS`.
Without Postmark credentials: dev prints emails, production refuses to start. Without Twilio credentials the SMS channel is disabled (logged as skipped).

## Tests

`pnpm -F worker test` uses the real local Postgres (`TEST_DATABASE_URL`, default `postgresql://postgres@127.0.0.1:5433/dsg_test`) but its own database
`<name>_worker`, created on demand, so it can run alongside the API tests. Provider HTTP is exercised with a fake `fetch` only.
