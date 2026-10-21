# Changelog

Newest first. Every PR adds a line. Lead writes a gate report at each phase gate.

## Unreleased

### Phase 1 Foundation (lead scaffold)
- pnpm workspace (`packages/shared`, `apps/api`, `apps/worker`, `tests/e2e`, `app`, `extensions/*`), strict `tsconfig.base.json`.
- `docs/openapi.yaml` v0.1.0: customer (`/c`) and staff (`/s`) routes, `{code,message}` errors, webhooks. Customer schemas contain no cost, margin or internal notes (enforced by `packages/shared/test/openapi-contract.test.ts`).
- Types generated to `packages/shared/src/api.ts` (`pnpm -F shared gen:types`); Prism mock via `pnpm -F shared mock`.
- State machine: 386 exhaustive tests (10 statuses x 11 events x 3 actors, isPurchasable, customerCanEditLines, waitingOn).
- **Fix** `quote-state.ts`: `transition()`/`canTransition()` resolved inherited keys such as `"toString"` or `"constructor"` as rules (TypeError instead of `TransitionError`). Now own-property lookups; `TransitionError.name` set.
- `ADMIN_API_VERSION = "2026-07"` in `packages/shared/src/shopify.ts` (to be confirmed against shopify.dev).
- `render.yaml` (web, worker, cron, Postgres) and `.env.example`.
- `docs/SETUP.md` manual steps; `docs/ISSUES.md` builder issues.
- Open: gate "Render services up" and "Twilio A2P + email domain started" wait on `docs/SETUP.md` steps 4-6.
