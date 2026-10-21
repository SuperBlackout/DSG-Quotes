import { S3AttachmentSigner, type AttachmentSigner } from "./attachments";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { createPrisma } from "./db";
import { ApiError } from "./errors";
import { RealShopify } from "./shopify/real";

/** `pnpm -F api start`: the production entrypoint (Render dsg-quotes-web). */
async function main() {
  const config = loadConfig();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Missing required env var DATABASE_URL");
  const prisma = createPrisma(databaseUrl);

  const shopify = new RealShopify({
    shopDomain: config.shopDomain,
    getAccessToken: async () => {
      const s = await prisma.session.findFirst({ where: { shop: config.shopDomain, isOnline: false }, orderBy: { expires: "desc" } });
      if (!s) throw new Error(`No offline Shopify session stored for ${config.shopDomain}; install the app first`);
      return s.accessToken;
    },
  });

  const attachments: AttachmentSigner = config.attachments
    ? new S3AttachmentSigner(config.attachments)
    : {
        createUpload() {
          throw new ApiError("INTERNAL", "Attachments are not configured");
        },
        isOwnUrl: () => false,
      };

  const app = await buildApp({ config, prisma, shopify, attachments, now: () => new Date() }, { logger: true });
  const close = async () => {
    await app.close();
    await prisma.$disconnect();
  };
  process.on("SIGTERM", () => void close().then(() => process.exit(0)));
  process.on("SIGINT", () => void close().then(() => process.exit(0)));
  await app.listen({ port: config.port, host: config.host });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
