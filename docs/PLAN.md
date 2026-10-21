# DSG Quotes — plan summary for builders

- Full plan (research, requirements, diagrams): https://claude.ai/artifact/63E6vCbqGPVzcSn3FhY31G
- Screen mockups: https://claude.ai/artifact/Ac8XNazbtP2xDBRAwjHnPr
  (1 Product page · 2 Cart · 3 My Quotes · 4 Quote detail + chat · 5 Notification settings · 6 Sales inbox · 7 Sales editor)

## Lifecycle

DRAFT → SUBMITTED → IN_REVIEW → QUOTE_READY (vN) ⇄ CHANGES_REQUESTED → ACCEPTED → ORDERED
Side exits: EXPIRED (cron), DECLINED, ARCHIVED (deleted draft). Source of truth: `packages/shared/src/quote-state.ts`.

## API contract (lead turns this into `docs/openapi.yaml` on day 1)

Customer routes — called via the app proxy (`/apps/quotes/*`, HMAC-verified) from storefront blocks, and
with the customer account session token from the My Quotes extension. Scope: caller's company location.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /c/quotes?status=&jobId=&q= | List my company's quotes (grouped by job client-side) |
| POST | /c/quotes | Create quote `{title, jobId? , newJob?:{name, poNumber}}` |
| GET | /c/quotes/:id | Quote + current version lines (no cost), messages (no internal) |
| PATCH | /c/quotes/:id | Header fields: title, job, PO, neededBy, shipTo, notesToSales (DRAFT only for lines) |
| DELETE | /c/quotes/:id | Soft delete — DRAFT only |
| POST | /c/quotes/:id/lines | Add `{variantId, qty}` — DRAFT only; price snapshot from buyer's catalog |
| PATCH/DELETE | /c/quotes/:id/lines/:lineId | Edit qty / remove — DRAFT only |
| POST | /c/quotes/from-cart | Copy current cart into new or existing draft `{cartLines, target}` |
| POST | /c/quotes/:id/submit · /withdraw · /accept · /request-changes · /decline | State transitions |
| POST | /c/quotes/:id/duplicate | Copy any quote to a new DRAFT |
| POST | /c/quotes/:id/checkout | ACCEPTED + not expired → create/refresh draft order, return invoiceUrl |
| GET/POST | /c/quotes/:id/messages | Chat (attachments via signed upload URL) |
| GET/PUT | /c/notification-prefs | Per-event email/SMS, phone, opt-in, quiet hours, watchers |
| GET | /c/active-quote · PUT /c/active-quote | Which draft "Add to Quote" targets (header chip) |

Staff routes — embedded admin app, Shopify session token.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /s/quotes?tab=needs_response\|unassigned\|waiting_customer\|accepted\|expiring&rep=&team= | Inbox |
| GET | /s/quotes/:id | Full quote incl. cost, margin, internal notes, all versions |
| POST | /s/quotes | Create quote on behalf of a customer |
| POST | /s/quotes/:id/claim · /assign `{repId\|teamId}` | Ownership |
| PUT | /s/quotes/:id/draft-revision | Save working lines, freight, expiry, notes (not visible to customer) |
| POST | /s/quotes/:id/send | Freeze working lines into version N+1 → QUOTE_READY; floor check |
| POST | /s/quotes/:id/approve-floor | Manager approval for lines under price floor |
| POST | /s/quotes/:id/reopen | ACCEPTED → IN_REVIEW |
| GET/POST | /s/quotes/:id/messages | Chat incl. `internal: true` notes |
| GET | /s/reports/summary | Inbox tiles (needs response, open value, accepted this week, expiring) |

Webhooks: `orders/create` (match `draftOrderId` → ORDER_PLACED), `draft_orders/update`, `app/uninstalled`,
plus mandatory compliance webhooks. Inbound: `/hooks/email-inbound`, `/hooks/twilio-inbound` → messages.

## Accept → buy (backend)

1. `isPurchasable()` check. 2. `draftOrderCreate` with `purchasingEntity` = company contact + location,
line items using `priceOverride` at `quotedPrice`, shipping line for freight, tag `quote:Q-#####`,
note = job/PO, `poNumber` = PO. 3. Return `invoiceUrl` (card) — or, for net-terms locations, complete with
payment terms per Shopify B2B draft-order flow. 4. Store `draftOrderId`. Re-use it if the customer clicks Buy
again; recreate only if the quote was reopened.
Confirm exact field names against the pinned Admin API version before coding (`graphql:validate`).

## Phases and gates

| Phase | Weeks | Gate |
| --- | --- | --- |
| 1 Foundation | 1–2 | State-machine tests green; Render services up; Twilio A2P + email domain started |
| 2 Customer quoting | 2–4 | Dealer builds + submits a quote on the dev store |
| 3 Sales inbox + revisions | 4–6 | Rep reprices, sends v2; customer sees diff |
| 4 Chat + notifications | 5–7 | Every event fires email + SMS; replies land in chat |
| 5 Accept → buy + launch | 7–9 | Pilot dealers place 3 real orders from quotes |
