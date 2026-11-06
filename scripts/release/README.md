# Release tool

One command ships the Shopify and Render pieces, asking y/n before every step that changes something.

```powershell
pnpm release              # guided release
pnpm release --dry-run    # print what would happen, change nothing
```

Owner: **lead** (new folder, outside the per-agent layout in CLAUDE.md).

## Prerequisites

- Windows PowerShell 5.1 or newer, Node 20+ and pnpm (`corepack enable`)
- Python 3.10+ (standard library only, no pip installs)
- Shopify CLI, logged in (`shopify auth login`), with access to the dsg.direct store
- `RENDER_API_KEY` set in your shell (Render > Account Settings > API Keys). It is read from the
  environment only and is never written to the repo or the log.

```powershell
$env:RENDER_API_KEY = "rnd_..."   # this session only
```

- `shopify.app.toml` in the repo root, for step 3. If it is missing the tool stops and tells you to run
  `shopify app config link`.
- `SHOPIFY_SCHEMA_PATH` pointing at the downloaded Admin GraphQL schema (introspection JSON or SDL, API version
  pinned in `packages/shared/src/shopify.ts`). `pnpm -F api graphql:validate` needs it; preflight stops early if it is not set
  (see `apps/api/README.md`).
- Optional: `TEST_DATABASE_URL` pointing at a **throwaway** Postgres. The API tests wipe it.

## Flags

| Flag | Effect |
| --- | --- |
| `--dry-run` | Print every action, run nothing, call no network. |
| `--yes` | Skip y/n prompts. Still asks for the live-theme confirmation and before pushing the tag. Theme files use the default selection. |
| `--only <step>` | Run only that step (repeatable or comma separated). |
| `--skip <step>` | Skip that step (repeatable). |

Steps: `preflight`, `render`, `shopify`, `theme`, `smoke`, `tag`.

## What it does

1. **Preflight**: on `main`, clean, equal to `origin/main`; `pnpm install --frozen-lockfile`; `pnpm test`;
   `pnpm -F api graphql:validate`. Without `TEST_DATABASE_URL` the suites that need Postgres (`api`, `worker`,
   `e2e`, `@dsg/identity`, `@dsg/statement`) are skipped and the tool says so. Any failure stops the release.
2. **Render**: looks services up by name, deploys `dsg-quotes-web` at the tested commit (its pre-deploy command runs
   `prisma migrate deploy`), waits until live, and checks the deploy logs. Then `dsg-quotes-admin`, then
   `dsg-quotes-worker` if you say yes. A failed deploy prints the last log lines and stops.
   Admin is **not** deployed unless the migration check passes:
   - "All migrations have been successfully applied" is the pass for a release with new migrations.
   - "No pending migrations to apply" (prisma's message when the database is already current) is also accepted and reported as such.
   - A migration error, or neither message, stops the release.
3. **Shopify app**: `shopify app deploy` (customer-account extensions and app config).
4. **Theme**: lists the files in `theme-overrides/assets/` changed since the latest `release-*` tag. With no tag yet it lists all
   known assets and defaults to `dsg-quotes-page.js` only. You pick files and the theme. They are copied to a temp folder and
   pushed with `shopify theme push --only assets/<file> --nodelete`. Choosing the live theme needs you to type `PUSH TO LIVE`
   (`--yes` does not skip it) before `--allow-live` is used.
5. **Smoke test**: `GET /healthz` on web and admin.
6. **Tag**: creates `release-YYYY-MM-DD-N` locally. It is pushed only if you confirm.

Settings (service names, theme globs, default theme files, timeouts) are in `release.config.json`. It holds no secrets.

## Logs

Each run writes `scripts/release/logs/<timestamp>.log` (gitignored). Known secrets and token-shaped strings
(`rnd_`, `shpat_`, Bearer tokens, `api_key=`) are masked in both the console and the file.

## Roll back

- **Render**: dashboard > the service > Events/Deploys > pick the last good deploy > **Rollback**. Do web, then admin, then worker.
- **Database**: roll back needs nothing for the usual case. The migrations so far only add things (tables, columns, enum values),
  so the previous code keeps working against the newer schema. Do not run `prisma migrate` backwards or drop anything by hand.
- **Theme**: re-push the previous version of the file, from the previous tag: `git checkout <old-tag> -- theme-overrides/assets/<file>`
  then `pnpm release --only theme`. Or restore it from the theme's version history in the Shopify admin.
- **Shopify app**: run `shopify app deploy` again from the last good commit.
- A release tag that was pushed by mistake: `git push origin :refs/tags/<tag>` and `git tag -d <tag>`.

## Tests

`pnpm test` also runs the Python unit tests (`tests/test_release.py`): deploy polling, migration-log parsing, tag and
theme-selection logic, token masking and the Render client, all against mocked responses.
