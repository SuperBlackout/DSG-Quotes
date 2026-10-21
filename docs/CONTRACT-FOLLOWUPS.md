# Contract 0.2.0 follow-ups (code changes owed by each builder-owned folder)

The lead changed only `docs/` and `packages/shared/` (plus `.env.example`). Each folder owner applies the items below in
its own PR, then pulls the regenerated `packages/shared/src/api.ts`. Item ids are stable so PRs can reference them
(for example `API-7`). Source of truth: `docs/openapi.yaml` v0.2.0.

Totals: apps/api 21, apps/worker 6, app/ 14, extensions/quote-blocks 5, extensions/my-quotes 13, tests/e2e 6.

## apps/api (backend) - 21

- API-1 `POST /c/quotes/from-cart` `target.mode=existing`: accept and persist `poNumber`, `neededBy`, `notesToSales` (only when present); ignore `emptyCart`.
- API-2 `GET /c/quotes?status=DRAFT&limit=100` must accept limit up to 100 (clamp above 100 to 100 or reject VALIDATION_FAILED, pick one and test it).
- API-3 `PUT /c/active-quote`: accept a just-created own DRAFT and `quoteId: null`; 404 for another company's quote.
- API-4 Serve every `/c/*` route also at the absolute origin `https://quotes.dsg.direct/c/*` (no `/apps/quotes` prefix) with customer-account session token auth; app proxy HMAC only on the proxy path.
- API-5 CORS on `/c/*`: echo `Origin` including literal `null`, allow `Authorization, Content-Type`, methods `GET, POST, PUT, PATCH, DELETE, OPTIONS`, `Access-Control-Max-Age: 600`, no credentials header; unauthenticated 204 for `OPTIONS` on every `/c/*` path; no CORS headers on `/s/*` or `/hooks/*`.
- API-6 `CustomerQuoteSummary`: add `assignedRepName`, `unreadCount` (customer-visible messages unread by this customer, never internal), `previousTotal` (total of the prior sent version, else null), `currencyCode` (ISO 4217, shop currency). Remove the duplicate `assignedRepName` handling on `CustomerQuote`.
- API-7 `CustomerQuoteActions.canEditHeader` computed from the state machine (true in DRAFT).
- API-8 `GET /c/quotes/{id}/pdf` (+ `?version=N`): customer-safe PDF of a sent version, 404 until one is sent, `application/pdf`, inline disposition; no cost, margin or internal notes.
- API-9 `NotificationPrefs`: store exactly the seven event keys (QUOTE_RECEIVED, QUOTE_READY, NEW_MESSAGE, EXPIRING, ORDERED, ACCEPTED, WEEKLY_SUMMARY), all required on PUT, unknown keys rejected; migrate the old CHANGES_REQUESTED key away.
- API-10 `NotificationPrefs.watchers`: store `Watcher {email, name, role, scope (all | job id), channels{email,sms}}`; validate scope job ids belong to the caller's company. Quote-level `watchers` stay `string[]` of emails.
- API-11 Error semantics: 409 `NOT_PURCHASABLE` from `/checkout`, 409 `VERSION_MISMATCH` (with `details.currentVersion`) from `/accept`; add tests for both.
- API-12 `GET /s/me`, `GET /s/staff`, `PUT /s/staff/{id}`, `GET/POST/PUT/DELETE /s/teams`, `GET/PUT /s/settings` (manager or admin for writes; delete of the default team returns 400), `GET/PUT /s/saved-replies` (shared replies manager only). Needs Prisma models/migration for staff role, teams, settings, routing rules, saved replies.
- API-13 `POST /s/quotes/{id}/request-floor-approval`: no status change, write `FLOOR_APPROVAL_REQUESTED` event row, notify managers; `approve-floor` requires manager or admin.
- API-14 `GET /s/quotes`: `rep=me|unassigned|<staffId>`; `q` also matches display number (`Q-10482`, `q10482`, `10482`); rows include `itemCount` (number of lines) and `currencyCode`.
- API-15 `GET /s/reports/summary`: add `tabCounts` for the six tabs, same predicates as the list tabs.
- API-16 `GET /s/customers?q=` (min 2 chars; name, email, phone, company) returning customer plus company locations.
- API-17 No `/s/variants/{id}` endpoint. `PUT draft-revision` must snapshot buyer-contextual `listPrice` and inventory `cost` for new `variantId`s, and return `cost`, `marginPct`, `belowFloor`, `costUnknown` on `workingLines`.
- API-18 Unknown cost: set `costUnknown=true`, `marginPct=null`, `belowFloor=true`; `send` returns 422 `FLOOR_APPROVAL_REQUIRED` (`details.lineIds`) until a manager approves the line.
- API-19 `StaffQuote`: add `paymentTerms`, `customerContactName`, `customerContactPhone`, `workingExpiresAt` (persisted by draft-revision, copied to `expiresAt` on send, else `QUOTE_DEFAULT_EXPIRY_DAYS`), `nextVersionNo = max(currentVersion, max(versions[].versionNo)) + 1`; `send` uses `nextVersionNo`.
- API-20 `POST /s/quotes/{id}/attachments/upload-url` (same shapes as customer upload; uses `ATTACHMENTS_REGION`, `ATTACHMENTS_PUBLIC_BASE_URL`).
- API-21 `POST /webhooks/shopify`: verify `X-Shopify-Hmac-Sha256` with `SHOPIFY_API_SECRET`, dispatch on `X-Shopify-Topic`, idempotent on `X-Shopify-Webhook-Id`, 200 within 5 s. Also: mount `/hooks/email-inbound` and `/hooks/twilio-inbound` routes in `apps/api` (handlers by notifications), read the new env vars (`ATTACHMENTS_REGION`, `ATTACHMENTS_PUBLIC_BASE_URL`, `QUOTE_DEFAULT_EXPIRY_DAYS`, `SIGNATURE_MAX_AGE_SECONDS`), keep `lineNote` customer-visible and `internalNote` out of every customer serializer, and do not implement rate limiting yet (do not emit `RATE_LIMITED`). Serializer tests must cover the new customer fields (still no cost, margin, internalNote, costUnknown).

## apps/worker (notifications) - 6

- WRK-1 Recipient/preference lookup keyed by the seven event keys; map `SUBMIT` to QUOTE_RECEIVED, `SEND_REVISION` to QUOTE_READY, staff message to NEW_MESSAGE, 3-day reminder to EXPIRING, `ORDER_PLACED` to ORDERED, `ACCEPT` to ACCEPTED; staff-bound events (REQUEST_CHANGES) are not customer preferences.
- WRK-2 Weekly cron: WEEKLY_SUMMARY digest of the customer's open quotes (new job in `render.yaml` cron is the lead's; worker adds the handler).
- WRK-3 Watchers: honor `scope` (`all` or a job id matching the quote's job) and per-watcher `channels`; SMS to a watcher still needs that person's own opt-in.
- WRK-4 New event `FLOOR_APPROVAL_REQUESTED`: notify managers (email; in-app only if supported). Never customers.
- WRK-5 Implement the inbound handlers for `/hooks/email-inbound` and `/hooks/twilio-inbound` as library functions that `apps/api` mounts (backend mounts the routes); signature verification stays in the handlers.
- WRK-6 Links in email/SMS use `APP_PUBLIC_URL`; PDF link uses `GET /c/quotes/{id}/pdf` only for customer-safe content.

## app/ (admin) - 14

- ADM-1 Use `GET /s/me` for role, teams and `effectivePriceFloorPct`; hide manager-only actions (approve floor, settings writes) for reps using `canApproveFloor` / `canEditSettings`.
- ADM-2 Inbox: `rep=me` and `rep=unassigned` filters, tab badges from `StaffSummary.tabCounts`, search box passes `Q-#####` straight to `q`, show `itemCount` per row, `currencyCode` for formatting.
- ADM-3 Settings page: staff list (`GET /s/staff`, role/teams/personal floor/active via `PUT /s/staff/{id}`).
- ADM-4 Settings page: teams CRUD (`/s/teams`); handle 400 when deleting the default team.
- ADM-5 Settings page: `defaultPriceFloorPct`, `routing.defaultTeamId`, `routing.autoAssignByCompany`, rules (`/s/settings`, full replace on PUT).
- ADM-6 Saved replies picker in the conversation (`GET /s/saved-replies`) and a manage screen (`PUT`, full replace; `shared` only for managers).
- ADM-7 "Request manager approval" button calls `POST /s/quotes/{id}/request-floor-approval`; managers see Approve (`approve-floor`).
- ADM-8 Product picker: after adding a variant, immediately `PUT draft-revision`; render list price, cost and margin from the response (no variant lookup route).
- ADM-9 Lines with `costUnknown` show an "Unknown cost" badge, margin shown as a dash, and block Send until approved (handle 422 `FLOOR_APPROVAL_REQUIRED` as today).
- ADM-10 Send button label uses `StaffQuote.nextVersionNo` ("Send v3"), never `currentVersion + 1`.
- ADM-11 Create-on-behalf dialog: customer search via `GET /s/customers?q=` (debounced, min 2 chars), pick a company location, then `POST /s/quotes`.
- ADM-12 Editor header: show `paymentTerms`, `customerContactName`, `customerContactPhone`; expiry field reads/writes `workingExpiresAt` (sent as `expiresAt` in draft-revision).
- ADM-13 Staff message composer: attachments via `POST /s/quotes/{id}/attachments/upload-url` (PUT file to `uploadUrl`, send `fileUrl` in `attachments`).
- ADM-14 UI copy: `lineNote` is labelled "Visible to customer"; the quote `internalNote` is labelled "Internal only" and visibly distinct.

## extensions/quote-blocks (storefront) - 5

- SF-1 Cart block, "Move cart to quote" into an existing draft: send `poNumber`, `neededBy`, `notesToSales` in `target` when the user filled them.
- SF-2 Do not rely on `emptyCart`; clear the cart client-side only after a 2xx (may still send the flag for logging).
- SF-3 After "Save as draft" from the cart, call `PUT /c/active-quote` with the returned quote id so the header chip follows.
- SF-4 Popover draft list: `GET /c/quotes?status=DRAFT&limit=100`.
- SF-5 Regenerate types from `packages/shared`; no usage of removed/renamed fields (none removed for this folder, but `currencyCode` is now present on quote summaries and can be used for formatting).

## extensions/my-quotes (customer-account) - 13

- CA-1 Call the API on the absolute origin `https://quotes.dsg.direct/c/*` with `Authorization: Bearer <session token>`; remove any app proxy assumptions; declare network access in the extension toml (see SETUP).
- CA-2 List rows: show `assignedRepName`, an unread badge from `unreadCount`, and "was $X" from `previousTotal` when the total changed.
- CA-3 Use `actions.canEditHeader` for the editable job details form (not `canEditLines`).
- CA-4 Format money with `currencyCode`.
- CA-5 Notification matrix: render exactly the seven events with friendly labels (Quote received, Quote ready, New message, Expiring soon, Ordered, Accepted, Weekly summary); PUT sends all seven keys.
- CA-6 Watchers editor: name, role, email, scope (All quotes or a specific job), channels (email/SMS); sends `Watcher[]`.
- CA-7 Quote detail: "Download PDF" via `GET /c/quotes/{id}/pdf` (fetch with the Authorization header, open the blob; a plain link cannot send the header).
- CA-8 Checkout error handling: `NOT_PURCHASABLE` shows the message and an "Ask for a new quote" button that calls `POST /c/quotes/{id}/duplicate` and navigates to the new draft.
- CA-9 Accept error handling: `VERSION_MISMATCH` reloads the quote, switches to the new version tab and asks the customer to re-review before accepting again.
- CA-10 Handle CORS failures gracefully (network error state with retry), since the extension runs with a `null` origin.
- CA-11 Quote-level `watchers` remain emails (`string[]`); do not send `Watcher` objects to `PATCH /c/quotes/{id}`.
- CA-12 Add "My Quotes" to the account menu in the toml/target config; document that the merchant must also add it manually in the editor (SETUP step 2).
- CA-13 Types from `Schemas["Customer*"]` only; re-run the no-cost/margin grep after regenerating.

## tests/e2e (qa) - 6 (not requested by a builder, owed by the new contract)

- QA-1 Contract tests validate responses for the new routes (`/s/me`, `/s/staff`, `/s/teams`, `/s/settings`, `/s/saved-replies`, `/s/customers`, `/c/quotes/{id}/pdf`).
- QA-2 CORS: preflight from `Origin: null` on `/c/quotes` returns 204 with the headers in `info.x-cors`; none on `/s/*`.
- QA-3 Privacy: new customer fields and PDF contain no cost, margin, `internalNote`, `costUnknown`.
- QA-4 Unknown-cost flow: line with no inventory cost cannot be sent until manager approval; request-floor-approval notifies a manager.
- QA-5 `NOT_PURCHASABLE` (expired accepted quote) offers duplicate; `VERSION_MISMATCH` accept after resend.
- QA-6 Send version number equals `nextVersionNo` after a reopen/resend sequence.
