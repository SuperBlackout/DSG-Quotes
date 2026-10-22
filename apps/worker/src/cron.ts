import { buildProviders, consoleLogger, loadNotifyConfig, type WorkerDeps } from "./config";
import { runCron } from "./cron/run";
import { createPrisma } from "./db";
import pg from "pg";
import { ZohoClient, loadZohoConfigFromEnv } from "@dsg/zoho";
import type { StatementCronDeps } from "./cron/statementSync";

const ZOHO_KEYS = ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN", "ZOHO_ORG_ID"];

/** `pnpm -F worker cron`: Render cron job (dsg-quotes-cron), hourly. Exits non-zero if any step failed so Render flags the run. */
async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Missing required env var DATABASE_URL");
  const prisma = createPrisma(databaseUrl);
  try {
    const { email, sms } = buildProviders(process.env, consoleLogger);
    const deps: WorkerDeps = { prisma, email, sms, config: loadNotifyConfig(), now: () => new Date(), log: consoleLogger };
    // Account statements: only when the Zoho credentials are present (same switch as the API's /a routes).
    let statement: StatementCronDeps | undefined;
    const present = ZOHO_KEYS.filter((k) => process.env[k]);
    if (present.length && present.length !== ZOHO_KEYS.length) throw new Error(`Zoho is partly configured; set all of ${ZOHO_KEYS.join(", ")} or none`);
    if (present.length) statement = { pool: new pg.Pool({ connectionString: databaseUrl, max: 2 }), zoho: new ZohoClient(loadZohoConfigFromEnv()) };
    try {
      const result = await runCron(deps, statement);
      if (result.errors.length) process.exitCode = 1;
    } finally {
      await statement?.pool.end();
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
