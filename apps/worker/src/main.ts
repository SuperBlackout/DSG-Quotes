import { buildProviders, consoleLogger, loadNotifyConfig, type WorkerDeps } from "./config";
import { createPrisma } from "./db";
import { sendOptInRequests } from "./optin";
import { processBatch } from "./processor";

/** `pnpm -F worker start`: Render background worker (dsg-quotes-worker). Polls the `events` table until SIGTERM. */
async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Missing required env var DATABASE_URL");
  const prisma = createPrisma(databaseUrl);
  const { email, sms } = buildProviders(process.env, consoleLogger);
  const deps: WorkerDeps = { prisma, email, sms, config: loadNotifyConfig(), now: () => new Date(), log: consoleLogger };
  const pollMs = Number(process.env.WORKER_POLL_MS ?? 5000);

  let stopping = false;
  let wake: (() => void) | null = null;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  deps.log.info("worker started", { pollMs, sms: sms ? "enabled" : "disabled" });
  while (!stopping) {
    let busy = false;
    try {
      const s = await processBatch(deps);
      busy = Object.entries(s.outcomes).some(([k, n]) => n > 0 && !["busy", "taken", "held", "error", "retry", "deferred_waiting"].includes(k));
      if ((await sendOptInRequests(deps)) > 0) busy = true;
    } catch (e) {
      deps.log.error("poll failed", { error: (e as Error).message });
    }
    if (!busy && !stopping) await new Promise<void>((resolve) => ((wake = resolve), setTimeout(resolve, pollMs)));
  }
  await prisma.$disconnect();
  deps.log.info("worker stopped");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
