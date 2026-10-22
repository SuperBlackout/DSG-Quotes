# Theme overrides (dsg.direct theme)

Copies of the storefront theme files that talk to DSG Quotes through the app proxy (`/apps/quotes`).
The theme itself lives in Shopify; these are here for version control. Upload to the theme's `assets/`.

- `assets/dsg-quote-bridge.js`: routes every "Add to Quote" / "move to quote" click into the real quote; header count. Loaded from `layout/theme.liquid` after `dsg-global.js`.
- `assets/dsg-quotes-page.js`: `/pages/quote` list and `?id=<quoteId>` detail (lines, messages, submit, accept, request changes, buy, withdraw, decline, PDF). Loaded by `snippets/dsg-quote.liquid`.
