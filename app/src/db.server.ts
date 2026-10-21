// Prisma is used only for Shopify session storage (the `Session` model in apps/api/prisma/schema.prisma).
// Quote data is reached through the /s API client, never through Prisma from this app.
//
// The client is loaded dynamically and typed structurally so that `pnpm typecheck` and the unit tests work
// without running `prisma generate` (which downloads engine binaries). Run `pnpm -F app prisma:generate`
// before `build` / `dev` / `start`.
import type { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";

type PrismaForSessions = ConstructorParameters<typeof PrismaSessionStorage>[0];

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaForSessions | undefined;
}

async function create(): Promise<PrismaForSessions> {
  // The schema uses engineType "client" (no Rust engine), which requires the pg driver adapter, as in apps/api/src/db.ts.
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const mod = (await import("@prisma/client")) as unknown as {
    PrismaClient: new (opts: { adapter: unknown }) => PrismaForSessions;
  };
  return new mod.PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
}

const prisma: PrismaForSessions = global.prismaGlobal ?? (await create());
if (process.env.NODE_ENV !== "production") global.prismaGlobal = prisma;

export default prisma;
