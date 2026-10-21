# extensions/quote-blocks

Owner: **storefront agent**. Theme app extension for DSG Quotes (mockup screens 1 and 2).

| File | What |
| --- | --- |
| `blocks/add-to-quote.liquid` | PDP app block: "Add to Quote" button + quote picker popover |
| `blocks/move-cart-to-quote.liquid` | Cart app block: move cart to a new or existing draft quote |
| `blocks/active-quote-chip.liquid` | App embed: "Adding to quote" chip (header) |
| `snippets/quote-card-button.liquid` | Optional collection-card button (`{% render 'quote-card-button', product: product %}`) |
| `assets/dsg-quotes-core.js` | Shared: proxy client, focus trap, formatting |
| `assets/dsg-add-to-quote.js`, `dsg-move-cart.js`, `dsg-quote-chip.js` | One per block |
| `assets/dsg-quotes.css` | Shared styles; colors inherit from the theme unless an accent color is set |

All network calls go to `/apps/quotes/c/*` (app proxy, see `docs/openapi.yaml`) plus the theme's own
`/cart.js` and `/cart/clear.js`.

## Tests
```bash
cd extensions/quote-blocks && npm install --no-package-lock   # jsdom (or pnpm install at repo root)
npm test                                                       # node --test + jsdom + fetch stub
```

## Manual steps on a live theme
Theme editor: add "Add to Quote" under Product information, "Move cart to quote" in the cart template,
enable the "Active quote chip" app embed. Set the *My Quotes URL* setting (the customer account page URL)
on each block / embed; `{id}` in the URL is replaced with the quote id.
