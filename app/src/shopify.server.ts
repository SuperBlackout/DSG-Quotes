import "@shopify/shopify-app-react-router/adapters/node";
import { ApiVersion, AppDistribution, shopifyApp } from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { ADMIN_API_VERSION } from "shared";
import prisma from "./db.server";

// ApiVersion.July26 === "2026-07". Keep in step with ADMIN_API_VERSION in packages/shared (lead owns it).
const apiVersion = ApiVersion.July26;
if ((apiVersion as string) !== ADMIN_API_VERSION) {
  throw new Error(`ApiVersion ${apiVersion} does not match ADMIN_API_VERSION ${ADMIN_API_VERSION}`);
}

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
});

export default shopify;
export { apiVersion };
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
