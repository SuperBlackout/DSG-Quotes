import type { Prisma, PrismaClient, StaffRole } from "@prisma/client";
import type { Config } from "./config";
import type { AttachmentSigner } from "./attachments";
import type { BuyerContext, ShopifyGateway } from "./shopify/types";
import type { StatementDeps } from "./statement/deps";

/** Everything the app needs injected: tests pass a fake Shopify, fake secrets and a test database. */
export interface AppDeps {
  config: Config;
  prisma: PrismaClient;
  shopify: ShopifyGateway;
  attachments: AttachmentSigner;
  /** Clock, injectable for expiry tests. */
  now: () => Date;
  /** Account pages (statement + account info). Absent unless Zoho is configured; the /a routes are then not mounted. */
  statement?: StatementDeps;
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
    role: StaffRole;
    /** Personal override; null = the shop default (ShopSetting.defaultPriceFloorPct). */
    priceFloorPct: Prisma.Decimal | null;
    shopifyStaffId: string | null;
  };
}

/** Managers and admins approve floor exceptions and edit teams/settings. */
export const isManagerRole = (role: StaffRole): boolean => role === "manager" || role === "admin";

declare module "fastify" {
  interface FastifyInstance {
    deps: AppDeps;
  }
  interface FastifyRequest {
    customer?: CustomerPrincipal;
    staffPrincipal?: StaffPrincipal;
  }
}
