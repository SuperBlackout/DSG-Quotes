# app/ (embedded admin)

Owner: **admin agent**. See `docs/AGENTS.md` (section 4) and `docs/ISSUES.md` (ISSUE-4).

React Router 7 + Polaris web components, written by hand against the Shopify React Router template (no CLI login
was available). Source is in `src/` (`react-router.config.ts` sets `appDirectory: "src"`).

| Path | What |
| --- | --- |
| `src/routes/app._index.tsx` | Screen 6, sales inbox |
| `src/routes/app.quotes.$id.tsx` | Screen 7, quote editor |
| `src/routes/app.q.$number.tsx` | Resolves `Q-#####` to the editor (target of the draft-order action) |
| `src/routes/app.settings.tsx` | Staff, teams, price floor, routing, saved replies |
| `src/lib/pricing.ts` | Pure money, margin, floor and totals math (integer cents) |
| `src/lib/editor-state.ts`, `editor-ops.ts` | Pure API-to-editor mapping and edits |
| `src/lib/api-client.ts` | Typed client for the `/s` routes in `docs/openapi.yaml` (the only place the app calls the quotes API) |
| `src/lib/staff.ts` | Pure helpers for `/s/me` permissions, floors, teams, settings payloads, saved replies, customer search |
| `src/lib/attachments.ts` | Staff message attachments: signed upload URL, PUT, attachment record |

Commands: `pnpm -F app test`, `pnpm -F app typecheck`, `pnpm -F app prisma:generate` (before `build`/`dev`; needs network
access to Prisma's engine binaries), `pnpm -F app build`.

Data is loaded in the browser (`clientLoader`) with an App Bridge session token (`shopify.idToken()`); the parent
`app.tsx` loader runs `authenticate.admin` on the server.
