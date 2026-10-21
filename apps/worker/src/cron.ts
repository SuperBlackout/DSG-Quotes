import { buildProviders, consoleLogger, loadNotifyConfig, type WorkerDeps } from "./config";
import { runCron } from "./cron/run";
import { createPrisma } from "./db";

/** `pnpm -F worker cron`: Render cron job (dsg-quotes-cron), hourly. Exits non-zero if any step failed so Render flags the run. */
async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Missing required env var DATABASE_URL");
  const prisma = createPrisma(databaseUrl);
  try {
    const { email, sms } = buildProviders(process.env, consoleLogger);
    const deps: WorkerDeps = { prisma, email, sms, config: loadNotifyConfig(), now: () => new Date(), log: consoleLogger };
    const result = await runCron(deps);
    if (result.errors.length) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
