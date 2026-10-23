# Theme overrides (dsg.direct theme)

Copies of the storefront theme files that talk to DSG Quotes through the app proxy (`/apps/quotes`).
The theme itself lives in Shopify; these are here for version control. Upload to the theme's `assets/`.

- `assets/dsg-quote-bridge.js`: routes every "Add to Quote" / "move to quote" click into the real quote; header count. Loaded from `layout/theme.liquid` after `dsg-global.js`.
- `assets/dsg-quotes-page.js`: `/pages/quote` list and `?id=<quoteId>` detail (lines, messages, submit, accept, request changes, buy, withdraw, decline, PDF). Loaded by `snippets/dsg-quote.liquid`.
- `assets/dsg-quote-notifications.js`: `/pages/quote?view=notifications`, the quote notification settings (alerts, mobile + text consent, quiet hours, teammates) on the storefront, over `GET/PUT /apps/quotes/c/notification-prefs`. `snippets/dsg-quote.liquid` (theme only) adds the "My quotes | Quote notifications" tabs and loads the right script.
- `assets/dsg-account-pages.js`: `/pages/statement` (balances, overdue, credit, activity with filters, statement and invoice PDFs) and `/pages/account-info` (company, terms, locations, contacts) over `GET/POST /apps/quotes/a/v1/*` (read-only, Location admins only). Setup: upload the file to the theme's `assets/`; in `layout/theme.liquid`, after `dsg-global.js`, add `{%- if page.handle == 'statement' or page.handle == 'account-info' -%}<script src="{{ 'dsg-account-pages.js' | asset_url }}" defer></script>{%- endif -%}`; create two Shopify pages (Online Store > Pages) with handles `statement` and `account-info` whose HTML content is `<div data-dsg-account="statement"></div>` and `<div data-dsg-account="account-info"></div>`; link them from the header or account menu (Content > Menus).
