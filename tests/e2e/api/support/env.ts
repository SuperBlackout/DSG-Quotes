import { join } from "node:path";

/**
 * Throwaway database for the runnable layer. WIPED (schema public dropped) at the start of every run.
 * Override with E2E_DATABASE_URL (preferred, lets this suite run next to `pnpm -F api test`) or TEST_DATABASE_URL.
 */
export const E2E_DB_URL =
  process.env.E2E_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5433/dsg_test";

/** Refuse to wipe anything that does not look disposable. */
export function assertDisposableDb(url: string): void {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (!/(test|e2e|scratch|tmp)/i.test(name) && process.env.E2E_ALLOW_WIPE !== "1") {
    throw new Error(
      `Refusing to wipe database "${name}": the name must contain test, e2e, scratch or tmp (set E2E_ALLOW_WIPE=1 to override).`,
    );
  }
}

export const E2E_ROOT = join(__dirname, "..", "..");
export const REPO_ROOT = join(E2E_ROOT, "..", "..");
/** Every request the suite makes is appended here so api/zz-coverage can check the contract is fully exercised. */
export const HITS_FILE = join(E2E_ROOT, ".hits.jsonl");
