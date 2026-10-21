# Builder issues

One issue per builder agent. Mockups: https://claude.ai/artifact/Ac8XNazbtP2xDBRAwjHnPr
(1 Product page, 2 Cart, 3 My Quotes, 4 Quote detail + chat, 5 Notification settings, 6 Sales inbox, 7 Sales editor).
Contract: `docs/openapi.yaml` + `packages/shared`. Branch `agent/<name>/<feature>`; PR to `main`; lead merges.
Global rules: `CLAUDE.md` (non-negotiables and definition of done). Prompts: `docs/AGENTS.md`.

Blockers common to all: live-store work needs `docs/SETUP.md` steps 1-3. Until then use `pnpm -F shared mock`.

---

## ISSUE-1 Backend (owner: `apps/api/`)  [label: backend]
Implement every operation in `docs/openapi.yaml` (customer `/c`, staff `/s`, webhooks except provider inbound parsing).

Acceptance criteria
- [ ] Prisma migrations from `apps/api/prisma/schema.prisma`; seed: 3 companies, 8 quotes covering every status.
- [ ] Auth: app proxy HMAC and customer-account token for `/c/*`; admin session token for `/s/*`. Every `/c` query scoped to the caller's company location; cross-company read returns 404.
- [ ] Every status change goes through `transition()` inside one DB transaction with one `events` row. No direct `quote.status` writes (grep check in CI).
- [ ] Screen 1/2: add line snapshots buyer-contextual price into `listPrice`/`quotedPrice`, cost from inventory unit cost; `from-cart` supports new/existing draft, `submit` flag, and returns the quote.
- [ ] Screen 3/4: list filters (`status`, `jobId`, `q`), per-row `actions` computed from the state machine (`isPurchasable`, `customerCanEditLines`); versions, messages (internal excluded), duplicate, withdraw, accept (409 `VERSION_MISMATCH` if stale), request-changes, decline.
- [ ] Screen 5: notification-prefs GET/PUT, SMS opt-in stores consent text and `smsOptInAt`.
- [ ] Screen 6/7: inbox tabs and tiles, claim/assign, draft-revision save, send (floor check returns 422 `FLOOR_APPROVAL_REQUIRED`, default expiry +14 days, creates `QuoteVersion`), approve-floor, reopen, internal notes.
- [ ] Checkout (screen 4 Buy now): `isPurchasable` re-checked server side, `draftOrderCreate` with company `purchasingEntity`, `priceOverride` at `quotedPrice`, freight shipping line, `quote:Q-#####` tag, idempotent reuse of `draftOrderId`, recreate only after reopen; field names checked via `pnpm -F api graphql:validate` against `ADMIN_API_VERSION`.
- [ ] Webhooks: `orders/create` -> ORDER_PLACED, `draft_orders/update`, `app/uninstalled`, compliance topics.
- [ ] Serializer tests: customer responses never contain `cost`, margin, `internalNote` or internal messages; responses validate against openapi.yaml.
- [ ] Every endpoint has a unit test; `pnpm -F api test` and typecheck green; `/healthz` exists; scripts `start`, `graphql:validate` added.

## ISSUE-2 Storefront theme blocks (owner: `extensions/quote-blocks/`)  [label: storefront]
Acceptance criteria
- [ ] Screen 1: "Add to Quote" app block on product templates: secondary button, popover with radio list of the customer's DRAFT quotes, "Start a new quote" (job name + PO), "Add to quote" then "View quote". Logged-out visitors see "Sign in to request a quote".
- [ ] Screen 1: popover is a focus trap, `aria-expanded` on the trigger, Esc closes, fully keyboard operable; axe clean.
- [ ] Screen 2: "Move cart to quote" cart block: new vs existing quote, job name, PO, needed-by, note to sales, "Empty my cart after moving", Save as draft and Submit to sales; cart cleared only after a 2xx.
- [ ] Header app embed "Active quote chip" shows target quote (`GET/PUT /c/active-quote`) and links to My Quotes.
- [ ] Optional collection-card snippet.
- [ ] All calls go through `/apps/quotes/*` only; vanilla JS + CSS, under 30 KB per block; theme editor settings for button label; colors inherit from theme.
- [ ] Works against the Prism mock and then the dev-store theme. Screenshot or GIF in the PR.

## ISSUE-3 Customer account My Quotes (owner: `extensions/my-quotes/`)  [label: customer-account]
Acceptance criteria
- [ ] Screen 3: list with chips (All, Waiting on you, With sales, Drafts, Closed) driven by `waitingOn`/status, search, group by Job, status-specific row actions (Review, Buy now, Submit, Delete draft, Duplicate, View order) taken from `actions` in the API, never recomputed.
- [ ] Screen 4: detail with editable job details (DRAFT), version tabs with "highlight changes" diff against previous version, status banner with Accept and Request changes, totals, rep notes, conversation with attachments (signed upload URL).
- [ ] Screen 4: Accept opens confirm dialog, then calls `/checkout`, redirects to `invoiceUrl`; expired or not purchasable shows the API message and offers "Ask for a new quote".
- [ ] Screen 5: notification settings matrix (event x email/SMS), contact fields, SMS opt-in with exact consent text, quiet hours, extra watchers; saves via `PUT /c/notification-prefs`.
- [ ] "My Quotes" in the account menu; target `customer-account.page.render`; Polaris web components.
- [ ] No `cost`/margin fields referenced anywhere (types come from `Schemas["Customer*"]`). Works on mock then real API; screenshots in PR.

## ISSUE-4 Admin app (owner: `app/`)  [label: admin]
Acceptance criteria
- [ ] Screen 6: tiles from `/s/reports/summary`, tabs (Needs response, Unassigned, Waiting on customer, Accepted, Expiring, All), search, rep/team filters, waiting timer, row opens editor.
- [ ] Screen 7: header (customer, job/PO, rep, expiry), change-request callout (`latestChangeRequest`), editable lines (qty, quote price, line note), cost/dealer/margin columns, floor warning and "Request manager approval" (`approve-floor`), Shopify resource picker for products, freight, totals with margin, customer-visible notes vs internal note.
- [ ] Screen 7: conversation with "To customer / Internal note" toggle and saved replies; internal notes visibly distinct.
- [ ] Buttons: Preview as customer, Save draft (`draft-revision`), Send vN (handles `FLOOR_APPROVAL_REQUIRED`); Claim and Assign work.
- [ ] Admin action extension on draft order details: "Open quote Q-#####".
- [ ] Settings: staff, teams, price floor %, routing (default team, auto-assign by company).
- [ ] Polaris web components; works against mock and then API; a rep can claim, reprice, message and send v2 on the dev store.

## ISSUE-5 Notifications worker (owner: `apps/worker/`)  [label: notifications]  (starts week 4+, needs the `events` table)
Acceptance criteria
- [ ] Worker consumes `events` where `notifiedAt IS NULL`; recipients from the `NOTIFY` map in `quote-state.ts` + assigned rep/team + customer owner + watchers, joined with `NotificationPref` (screen 5 settings).
- [ ] Email (Postmark) for: submitted (sales), quote ready, new message, changes requested, accepted, ordered, expiring; `Reply-To: q-<quoteId>-<token>@reply.dsg.direct`.
- [ ] SMS (Twilio Messaging Service): short text plus link; STOP/HELP handled, opt-out stored; no SMS without `smsOptInAt`.
- [ ] Quiet hours defer SMS (screen 5); NEW_MESSAGE bundled per quote within 5 min.
- [ ] Internal messages never produce customer notifications (test).
- [ ] Inbound email and Twilio hooks verify signatures, strip quoted text, create `Message` with channel EMAIL/SMS and emit NEW_MESSAGE; replies show in the chat on screens 4 and 7.
- [ ] Cron: hourly EXPIRE via `transition()`, daily 8:00 ET reminder for quotes expiring in 3 days, daily rep digest.
- [ ] Every send logged with provider id. Scripts `start`, `cron`, `build` exist (referenced by `render.yaml`). Blocked on Twilio A2P approval for live SMS; use verified numbers until then.

## ISSUE-6 QA (owner: `tests/e2e/`)  [label: qa]  (nightly from phase 2)
Acceptance criteria
- [ ] Fixtures: 2 companies, 3 dealers, 2 reps, 1 manager on the dev store (no real data).
- [ ] Flows: PDP add -> new quote (screen 1); cart -> quote (screen 2); submit; rep claim + reprice + send v2 (screens 6, 7); customer diff + request changes (screen 4); v3; accept -> checkout -> order -> ORDERED; expiry; delete draft; reopen.
- [ ] Privacy: internal note never visible to the customer; `cost`/margin absent from every customer network response; cross-company access is 404.
- [ ] Floor approval flow (screen 7).
- [ ] Contract tests: API responses validate against `docs/openapi.yaml`.
- [ ] axe checks on screens 1-7 with zero serious violations.
- [ ] Runs nightly and on PRs touching `apps/api` or `packages/shared`; posts a summary to the PR. Playwright dependencies added to `tests/e2e/package.json`.
