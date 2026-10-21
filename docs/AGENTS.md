# Agent team — how to run the build

One **lead** agent plans, owns the contract and merges. Six **builder** agents each work in their own git
worktree on their own folder (see `CLAUDE.md`). Paste each prompt below as that agent's task. Every agent
reads `CLAUDE.md` and `docs/PLAN.md` first.

## Run order

```
Day 1–2   lead: scaffold repo, openapi.yaml, shared types, state machine tests, Render services
Day 3+    backend ─┬─ storefront ─┐
                   ├─ customer-account ─┤  (all code against openapi.yaml + mock server)
                   └─ admin ────────────┘
Week 4+   notifications (needs events table)    qa (nightly e2e from phase 2)
Each gate lead merges, runs e2e, deploys to dev store, demos to DSG
```

Branches: `agent/<name>/<feature>`. PRs into `main`; only the lead merges. Mock server:
`pnpm -F shared mock` (Prism on `docs/openapi.yaml`) so front-ends never wait on backend.

---

## 0 · Lead / architect

> You are the lead engineer for DSG Quotes. Read `CLAUDE.md` and `docs/PLAN.md`.
> 1. Scaffold the repo with `shopify app init` (React Router template, TypeScript), convert to pnpm
>    workspaces with the folders in CLAUDE.md, add `packages/shared` and `apps/worker`.
> 2. Turn the API table in PLAN.md into `docs/openapi.yaml` (request/response schemas, error shape
>    `{code, message}`), generate types into `packages/shared/src/api.ts`, add a Prism mock script.
> 3. Keep `packages/shared/src/quote-state.ts` as given; write exhaustive unit tests for every
>    status × event × actor (allowed and refused).
> 4. Pin the Admin API version in `packages/shared/src/shopify.ts`; add `graphql:validate` script.
> 5. Create Render services (web, worker, cron, Postgres) and a `render.yaml`; wire env vars.
> 6. Open issues for each builder with acceptance criteria copied from the mockup screen numbers.
> 7. At each phase gate: review PRs, merge, run e2e, `shopify app deploy` to the dev store, write a short
>    gate report in `docs/CHANGELOG.md`.
> Never let a builder change the contract without a PR to `docs/`.

## 1 · Backend

> Own `apps/api/`. Build the REST API in `docs/openapi.yaml` on the React Router app server (or a
> Fastify service mounted alongside — your call, document it).
> - Auth: verify app proxy HMAC for `/c/*` from storefront; verify customer account session tokens for
>   `/c/*` from the extension; Shopify session tokens for `/s/*`. Resolve customer → company location
>   via Admin GraphQL and scope every query to it.
> - Prisma schema from `apps/api/prisma/schema.prisma`; migrations; seed script with 3 companies,
>   8 quotes in every status.
> - Price snapshot: on add line, read the buyer's contextual price (catalog for their company location)
>   and store as `listPrice` + `quotedPrice`; store `cost` from inventory item unit cost.
> - Wrap every transition in a transaction: `transition()` → update quote → insert `events` row.
> - `/s/quotes/:id/send`: freeze working lines into a new `QuoteVersion`, block if any line is under the
>   rep's `priceFloorPct` without manager approval, set `expiresAt` (default +14 days).
> - Checkout: implement "Accept → buy" from PLAN.md with draft orders; idempotent.
> - Webhooks: `orders/create` → ORDER_PLACED; compliance webhooks.
> - Serializer test: customer responses never contain `cost`, `margin`, `internalNote` or internal messages.
> Done when: contract tests pass against the real API; every endpoint has a unit test.

## 2 · Storefront (theme app extension)

> Own `extensions/quote-blocks/`. Match mockup screens 1 and 2.
> - App block "Add to Quote" for product templates: secondary button + popover listing the customer's
>   DRAFT quotes (radio), "Start a new quote" with job name + PO, "Add to quote" / "View quote".
>   Logged-out visitors see "Sign in to request a quote".
> - App block "Move cart to quote" for the cart template: new vs existing, job name, PO, needed-by,
>   note to sales, "Empty my cart after moving", Save as draft / Submit to sales.
> - App embed "Active quote chip" for the header: shows target quote, links to My Quotes.
> - Optional collection-card "Add to Quote" snippet.
> - Call the API only through `/apps/quotes/*` (app proxy). Vanilla JS + small CSS, no frameworks,
>   under 30 KB per block. Keyboard and screen-reader accessible (focus trap in popover, aria-expanded).
> - Theme editor settings: button label, colors inherit from theme.
> Done when: on the dev store theme a dealer can add from PDP and move a cart into a quote.

## 3 · Customer account (My Quotes)

> Own `extensions/my-quotes/`. Customer account UI extension, target `customer-account.page.render`,
> Polaris web components. Match mockup screens 3, 4 and 5.
> - Quote list: filter chips (All, Waiting on you, With sales, Drafts, Closed), search, group by Job,
>   row actions by status (Review, Buy now, Submit, Delete draft, Duplicate, View order).
> - Quote detail: job details (editable), version tabs with "highlight changes" diff vs previous version,
>   status banner with Accept / Request changes, totals, rep notes, conversation panel with attachments.
> - Accept → confirm dialog → call `/checkout` → redirect to the returned checkout/invoice URL.
> - Notification settings page: event × email/text matrix, contact fields, SMS opt-in with exact
>   consent text, quiet hours, extra watchers.
> - Add "My Quotes" to the account menu via the extension's menu config.
> Done when: screens 3–5 work end-to-end against the mock server, then the real API.

## 4 · Admin (sales team)

> Own `app/` routes for the embedded admin app. Polaris web components. Match mockups 6 and 7.
> - Inbox: summary tiles, tabs (Needs response, Unassigned, Waiting on customer, Accepted, Expiring,
>   All), search, rep/team filters, "waiting" timer, row → editor.
> - Editor: header (customer, job/PO, assigned rep, expiry), customer change-request callout, editable
>   lines (qty, quote price, line note), cost / dealer / margin columns, floor warning + "Request manager
>   approval", add product picker (Shopify resource picker), freight, totals + margin, customer-visible
>   job notes vs internal note, conversation with "To customer / Internal note" toggle and saved replies.
>   Buttons: Preview as customer, Save draft, Send vN.
> - Admin action extension on draft order details: "Open quote Q-#####".
> - Settings page: staff, teams, price floor %, routing (default team, auto-assign by company).
> Done when: a rep can claim, reprice, message and send v2 on the dev store.

## 5 · Notifications (worker)

> Own `apps/worker/`. Render background worker + cron.
> - Poll (or LISTEN/NOTIFY) `events` where `notifiedAt IS NULL`; resolve recipients from
>   `quote-state.ts` NOTIFY map + assigned rep / team list + customer owner + watchers; join
>   `NotificationPref`; respect quiet hours (defer SMS); bundle NEW_MESSAGE events per quote within 5 min.
> - Email via Postmark templates: submitted (to sales), quote ready, new message, changes requested,
>   accepted, ordered, expiring. Reply-To = `q-<quoteId>-<token>@reply.dsg.direct`.
> - SMS via Twilio Messaging Service: short text + link. Handle STOP/HELP, store opt-out.
> - Inbound: `/hooks/email-inbound` and `/hooks/twilio-inbound` verify signatures, strip quoted text,
>   post a `Message` with `channel` EMAIL/SMS, then emit NEW_MESSAGE.
> - Cron: daily 8:00 ET expiring-in-3-days reminders; hourly EXPIRE transitions; daily rep digest.
> - Never send internal messages to customers. Log every send with provider id.
> Done when: each row of the plan's Notifications table fires on both channels in the dev environment.

## 6 · QA

> Own `tests/e2e/`. Playwright against the dev store + admin.
> - Fixtures: 2 companies, 3 dealers, 2 reps, 1 manager; products from the dev catalog.
> - Flows: PDP add → new quote; cart → quote; submit; rep claim + reprice + send v2; customer diff +
>   request changes; v3; accept → checkout → order → status ORDERED; expiry; delete draft; internal note
>   never visible to customer; cost never in customer network responses; floor approval.
> - Contract tests: API responses match `docs/openapi.yaml`.
> - Accessibility: axe checks on screens 1–7.
> - Run nightly and on every PR touching `apps/api` or `packages/shared`; post a summary to the PR.
