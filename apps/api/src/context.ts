import type { Prisma, PrismaClient } from "@prisma/client";
import type { Config } from "./config";
import type { AttachmentSigner } from "./attachments";
import type { BuyerContext, ShopifyGateway } from "./shopify/types";

/** Everything the app needs injected: tests pass a fake Shopify, fake secrets and a test database. */
export interface AppDeps {
  config: Config;
  prisma: PrismaClient;
  shopify: ShopifyGateway;
  attachments: AttachmentSigner;
  /** Clock, injectable for expiry tests. */
  now: () => Date;
}

export type Tx = Prisma.TransactionClient;

/** Authenticated customer (company buyer) for /c routes. */
export interface CustomerPrincipal {
  kind: "customer";
  buyer: BuyerContext;
}

/** Authenticated staff member for /s routes. */
export interface StaffPrincipal {
  kind: "staff";
  staff: {
    id: string;
    name: string;
    email: string;
    isManager: boolean;
    priceFloorPct: Prisma.Decimal;
    shopifyStaffId: string | null;
  };
}

declare module "fastify" {
  interface FastifyInstance {
    deps: AppDeps;
  }
  interface FastifyRequest {
    customer?: CustomerPrincipal;
    staffPrincipal?: StaffPrincipal;
  }
}
