import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEALER_A, DEALER_B, FakeZoho } from "@dsg/testkit";
import { AccountMapRepo } from "@dsg/statement";
import { runCron, STATEMENT_SYNC_HOUR } from "../src/cron/run";
import { useWorker } from "./helpers";

const ctx = useWorker();
let pool: pg.Pool;

beforeAll(() => {
  pool = new pg.Pool({ connectionString: process.env.WORKER_TEST_DATABASE_URL });
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate account_map, zoho_contact, zoho_document, pdf_link, sync_event, access_audit");
  const repo = new AccountMapRepo(pool);
  for (const d of [DEALER_A, DEALER_B]) await repo.upsert({ shopifyCompanyId: d.companyId, zohoCustomerId: d.zohoId, customerNumber: d.number, displayName: d.name });
});
const cached = async () => Number((await pool.query("select count(distinct zoho_customer_id) from zoho_contact")).rows[0].count);

describe("nightly statement sync (cron)", () => {
  it("is skipped when Zoho is not configured (no statement deps)", async () => {
    ctx.clock.now = new Date("2026-03-02T09:00:00Z"); // 04:00 ET
    const r = await runCron(ctx.deps);
    expect(r.statementsSynced).toBe(0);
    expect(await cached()).toBe(0);
  });

  it(`does not run before ${STATEMENT_SYNC_HOUR}:00 ET, then syncs every linked account once per day`, async () => {
    const zoho = new FakeZoho();
    ctx.clock.now = new Date("2026-03-02T07:00:00Z"); // 02:00 ET
    expect((await runCron(ctx.deps, { pool, zoho })).statementsSynced).toBe(0);
    expect(zoho.calls).toBe(0);

    ctx.clock.now = new Date("2026-03-02T08:05:00Z"); // 03:05 ET
    const r = await runCron(ctx.deps, { pool, zoho });
    expect(r.statementsSynced).toBe(2);
    expect(r.errors).toEqual([]);
    expect(await cached()).toBe(2);

    const calls = zoho.calls;
    await runCron(ctx.deps, { pool, zoho }); // same day, again: the marker blocks it
    expect(zoho.calls).toBe(calls);

    ctx.clock.now = new Date("2026-03-03T08:05:00Z"); // next day: runs again
    await runCron(ctx.deps, { pool, zoho });
    expect(zoho.calls).toBeGreaterThan(calls);
  });

  it("skips deactivated mappings", async () => {
    await new AccountMapRepo(pool).deactivate(DEALER_B.companyId);
    ctx.clock.now = new Date("2026-03-02T08:05:00Z");
    expect((await runCron(ctx.deps, { pool, zoho: new FakeZoho() })).statementsSynced).toBe(1);
    expect((await pool.query("select zoho_customer_id from zoho_contact")).rows.map((x) => x.zoho_customer_id)).toEqual([DEALER_A.zohoId]);
  });

  it("when Zoho is down for everyone it reports the failure and retries on the next hourly run", async () => {
    const zoho = new FakeZoho();
    zoho.getContact = async () => { throw new Error("zoho down"); };
    ctx.clock.now = new Date("2026-03-02T08:05:00Z");
    const bad = await runCron(ctx.deps, { pool, zoho });
    expect(bad.statementsSynced).toBe(0);
    expect(bad.errors.some((e) => e.startsWith("statement-sync"))).toBe(true);

    ctx.clock.now = new Date("2026-03-02T09:05:00Z"); // an hour later, Zoho is back
    const good = await runCron(ctx.deps, { pool, zoho: new FakeZoho() });
    expect(good.statementsSynced).toBe(2);
  });

  it("one account failing does not stop the others, and is reported without retrying the whole run", async () => {
    const zoho = new FakeZoho();
    const real = zoho.getContact.bind(zoho);
    zoho.getContact = async (id: string) => { if (id === DEALER_B.zohoId) throw new Error("boom"); return real(id); };
    ctx.clock.now = new Date("2026-03-02T08:05:00Z");
    const r = await runCron(ctx.deps, { pool, zoho });
    expect(r.statementsSynced).toBe(1);
    expect(r.errors).toEqual(["statement-sync: 1 of 2 failed"]);
    expect(await cached()).toBe(1);
    const calls = zoho.calls;
    await runCron(ctx.deps, { pool, zoho });
    expect(zoho.calls).toBe(calls);
  });
});
