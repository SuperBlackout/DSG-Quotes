import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export interface TestPg { url: string; pool: pg.Pool; stop(): Promise<void>; }

/** SQL for the statement tables (same file the Prisma migration for production is built from). */
const STATEMENT_SQL = join(dirname(fileURLToPath(import.meta.url)), '../../statement/migrations/001_statement_tables.sql');

/**
 * Connects to the throwaway Postgres named by TEST_DATABASE_URL (the same one apps/api uses; it is wiped by the API
 * tests, so never point it at a real database), creates a private schema for this test file, applies the statement
 * tables inside it and returns a pool whose search_path is that schema. stop() drops the schema.
 */
export async function startTestPg(): Promise<TestPg> {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:5433/dsg_test';
  const schema = `st_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await admin.query(`create schema ${schema}`);
  } catch (e) {
    await admin.end().catch(() => {});
    throw new Error(`Cannot reach the test database at ${url} (${(e as Error).message}). Start a throwaway Postgres 16 and set TEST_DATABASE_URL.`);
  }
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  await pool.query(readFileSync(STATEMENT_SQL, 'utf8'));
  return {
    url, pool,
    async stop() {
      await pool.end();
      await admin.query(`drop schema ${schema} cascade`).catch(() => {});
      await admin.end();
    },
  };
}
