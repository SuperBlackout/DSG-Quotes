# extensions/my-quotes

Owner: **customer-account agent**. Customer account **full-page** UI extension (`customer-account.page.render`),
Preact + Polaris web components (`<s-page>`, `<s-stack>`, `<s-modal>` ...), TypeScript. Mockup screens 3, 4, 5.
Specs: `docs/AGENTS.md` section 3, `docs/ISSUES.md` ISSUE-3.

## Screens (all routes inside the one page, see `src/router.ts`)

| Route | File | Screen |
| --- | --- | --- |
| `extension://` | `src/routes/QuoteList.tsx` | 3 My Quotes: chips, search, group by, row actions |
| `extension://q/<id>` | `src/routes/QuoteDetail.tsx` + `src/components/*` | 4 Quote detail: banner, job details, versions + diff, totals, conversation |
| `extension://notifications` | `src/routes/Notifications.tsx` | 5 Notification settings |

A full-page target cannot share an extension with other targets and may be used once, hence routes via the Navigation API.

## Layout

- `src/api/` typed client (`client.ts`) over `Schemas["Customer*"]` from `packages/shared`; `types.ts` re-exports only customer shapes.
- `src/lib/` pure logic (diff, status -> actions, filters, notification form, consent text, formatting). All unit-tested.
- `src/ui/`, `src/components/`, `src/routes/` Polaris web component views.
- `test/` vitest. `test/mock.smoke.test.ts` runs against the Prism mock when `MOCK_API_URL` is set.

## Commands

```bash
pnpm -F my-quotes test         # unit tests
pnpm -F my-quotes typecheck    # tsc, also validates every <s-*> component name and prop
pnpm -F shared mock            # Prism on :4010, then:
MOCK_API_URL=http://localhost:4010 pnpm -F my-quotes test
```

## Backend requirements this extension relies on

- The extension runs in a Web Worker with a null origin: the API must serve `/c/*` over HTTPS with
  `Access-Control-Allow-Origin: *`, allow the `Authorization` header and answer `OPTIONS` preflights.
- Auth is `Authorization: Bearer <customer-account session token>` (`shopify.sessionToken.get()`, 5 minute expiry, fetched per request).
- Base URL: extension setting `api_base_url` (editable in the checkout and accounts editor), default `https://quotes.dsg.direct`.
- App needs "Allow network access in checkout and account UI extensions" approved in the Dev Dashboard (`network_access = true`).
- Attachment storage must allow `PUT` from a null origin (S3 CORS `AllowedOrigins: ["*"]` for the signed upload route).

## Menu entry

The "My Quotes" account menu item is added by the merchant, not in the toml: in the checkout and accounts editor
(Settings > Checkout > Customize), add the My Quotes page to the customer account header menu.

## Platform limits worth knowing

- The Navigation API cannot leave customer accounts, so after `/checkout` the UI shows a "Continue to checkout" link
  (`href`) instead of redirecting by script.
- `s-badge` only supports tones `auto | neutral | critical` in customer accounts.
