import type { Pool } from "pg";
import type { ZohoReader } from "@dsg/contracts";
import { safeMessage, syncAll } from "@dsg/statement";
import type { WorkerDeps } from "../config";

/** Zoho handles for the nightly statement refresh; absent when Zoho is not configured (the step is then skipped). */
export interface StatementCronDeps {
  pool: Pool;
  zoho: ZohoReader;
}

export interface StatementSyncResult {
  total: number;
  ok: number;
  failed: number;
}

/**
 * Full re-sync of every active account_map customer from Zoho Books (read-only). Webhooks keep the cache fresh during
 * the day; this is the safety net that also removes deleted/voided documents. Sequential, and one customer's failure
 * never stops the others (syncAll isolates them; failures are recorded in sync_event).
 */
export async function reconcileStatements(deps: WorkerDeps, st: StatementCronDeps): Promise<StatementSyncResult> {
  const r = await syncAll({ pool: st.pool, zoho: st.zoho, log: (msg, meta) => deps.log.warn(msg, { ...meta, scope: "statement-sync" }) });
  deps.log.info("statement sync finished", { total: r.total, ok: r.ok, failed: r.failed });
  return { total: r.total, ok: r.ok, failed: r.failed };
}

export { safeMessage };
