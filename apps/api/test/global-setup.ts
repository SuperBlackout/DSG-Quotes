import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5433/dsg_test";
export const HITS_FILE = join(__dirname, ".route-hits.jsonl");

/**
 * Resets the test database and applies every prisma/migrations/*\/migration.sql in order, using the SAME
 * SQL that `prisma migrate deploy` runs in production. Needs a throwaway Postgres (see README "Tests").
 */
export default async function setup() {
  const client = new pg.Client({ connectionString: TEST_DB_URL });
  try {
    await client.connect();
  } catch (e) {
    throw new Error(
      `Cannot reach the test database at ${TEST_DB_URL} (${(e as Error).message}). ` +
        `Start a throwaway Postgres 16 and set TEST_DATABASE_URL. Never point this at a real database: it is wiped.`,
    );
  }
  try {
    await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    const root = join(__dirname, "..", "prisma", "migrations");
    for (const dir of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
      await client.query(readFileSync(join(root, dir, "migration.sql"), "utf8"));
    }
  } finally {
    await client.end();
  }
  rmSync(HITS_FILE, { force: true });
  process.env.TEST_DATABASE_URL = TEST_DB_URL;
}
