import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { E2E_DB_URL, HITS_FILE, REPO_ROOT, assertDisposableDb } from "./env";

/**
 * Resets the disposable database and applies every apps/api/prisma/migrations/<dir>/migration.sql in order
 * (the same SQL `prisma migrate deploy` runs in production).
 */
export default async function setup() {
  assertDisposableDb(E2E_DB_URL);
  const client = new pg.Client({ connectionString: E2E_DB_URL });
  try {
    await client.connect();
  } catch (e) {
    throw new Error(
      `Cannot reach the e2e database at ${E2E_DB_URL} (${(e as Error).message}). ` +
        `Start a throwaway Postgres 16 and set E2E_DATABASE_URL (default postgresql://postgres@127.0.0.1:5433/dsg_test). It is wiped on every run.`,
    );
  }
  try {
    await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    const root = join(REPO_ROOT, "apps", "api", "prisma", "migrations");
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const dir of dirs) await client.query(readFileSync(join(root, dir, "migration.sql"), "utf8"));
  } finally {
    await client.end();
  }
  rmSync(HITS_FILE, { force: true });
}
