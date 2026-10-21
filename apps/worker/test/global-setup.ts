import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

/**
 * The worker's tests use their OWN database next to the API's (`<TEST_DATABASE_URL db name>_worker`, created on demand) so that
 * `pnpm test` can run both packages in parallel without wiping each other. Same migrations as production.
 */
const base = new URL(process.env.TEST_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5433/dsg_test");
const dbName = `${base.pathname.slice(1)}_worker`;
const workerUrl = (() => {
  const u = new URL(base);
  u.pathname = `/${dbName}`;
  return u.toString();
})();

export default async function setup() {
  const admin = new URL(base);
  admin.pathname = "/postgres";
  const a = new pg.Client({ connectionString: admin.toString() });
  try {
    await a.connect();
  } catch (e) {
    throw new Error(`Cannot reach Postgres at ${admin.host} (${(e as Error).message}). Set TEST_DATABASE_URL to a throwaway Postgres 16.`);
  }
  const exists = await a.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
  if (exists.rowCount === 0) await a.query(`CREATE DATABASE "${dbName}"`);
  await a.end();

  const c = new pg.Client({ connectionString: workerUrl });
  await c.connect();
  try {
    await c.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    const root = join(__dirname, "..", "..", "api", "prisma", "migrations");
    for (const d of readdirSync(root, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name).sort()) {
      await c.query(readFileSync(join(root, d, "migration.sql"), "utf8"));
    }
  } finally {
    await c.end();
  }
  process.env.WORKER_TEST_DATABASE_URL = workerUrl;
}
