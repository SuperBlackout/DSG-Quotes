import type { WorkerDeps } from "../config";
import { localParts } from "../lib/quiet-hours";
import { sendRepDigests } from "./digest";
import { expireDueQuotes } from "./expire";
import { queueExpiringReminders } from "./reminders";
import { sendWeeklySummaries } from "./weekly";

export const DAILY_TZ = "America/New_York";
export const DAILY_HOUR = 8;

export interface CronResult {
  expired: number;
  remindersQueued: number;
  digestsSent: number;
  weeklySent: number;
  ranDaily: boolean;
  errors: string[];
}

/** Once-a-day marker. The `Counter` table has a primary key on (shop, key), so the second insert fails and only one run wins. */
async function claimDaily(deps: WorkerDeps, key: string): Promise<boolean> {
  try {
    await deps.prisma.counter.create({ data: { shop: deps.config.shop, key, value: 1 } });
    return true;
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return false;
    throw e;
  }
}
const releaseDaily = (deps: WorkerDeps, key: string) => deps.prisma.counter.deleteMany({ where: { shop: deps.config.shop, key } });

/**
 * Entry point of `pnpm -F worker cron`, scheduled hourly by render.yaml.
 *  - every run: EXPIRE transitions;
 *  - the first run at or after 8:00 America/New_York each day: expiring-in-3-days reminders, then the rep digest
 *    (each guarded by its own once-a-day marker, so a late or repeated run cannot double-send);
 *  - on Mondays, from 8:00 ET: the customers' WEEKLY_SUMMARY email (own marker, so once per Monday).
 */
export async function runCron(deps: WorkerDeps): Promise<CronResult> {
  const result: CronResult = { expired: 0, remindersQueued: 0, digestsSent: 0, weeklySent: 0, ranDaily: false, errors: [] };
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      result.errors.push(`${name}: ${(e as Error).message}`);
      deps.log.error(`cron step failed: ${name}`, { error: (e as Error).message });
    }
  };

  await step("expire", async () => {
    result.expired = (await expireDueQuotes(deps)).expired.length;
  });

  const { date, hour, weekday } = localParts(deps.now(), DAILY_TZ);
  if (hour >= DAILY_HOUR) {
    await step("reminders", async () => {
      const key = `cron:reminders:${date}`;
      if (!(await claimDaily(deps, key))) return;
      result.ranDaily = true;
      try {
        result.remindersQueued = (await queueExpiringReminders(deps)).queued.length;
      } catch (e) {
        await releaseDaily(deps, key); // idempotent job: let the next hourly run retry
        throw e;
      }
    });
    await step("digest", async () => {
      // Claimed first and kept on failure: a partial send must not be repeated an hour later.
      if (!(await claimDaily(deps, `cron:digest:${date}`))) return;
      result.ranDaily = true;
      const r = await sendRepDigests(deps);
      result.digestsSent = r.sent;
      if (r.failed) result.errors.push(`digest: ${r.failed} failed`);
    });
    if (weekday === 1) {
      await step("weekly", async () => {
        if (!(await claimDaily(deps, `cron:weekly:${date}`))) return;
        result.ranDaily = true;
        const r = await sendWeeklySummaries(deps);
        result.weeklySent = r.sent;
        if (r.failed) result.errors.push(`weekly: ${r.failed} failed`);
      });
    }
  }
  deps.log.info("cron finished", { ...result });
  return result;
}
