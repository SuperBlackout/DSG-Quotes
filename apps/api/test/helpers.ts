import { appendFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { buildApp } from "../src/app";
import { FakeAttachmentSigner } from "../src/attachments";
import { signAppProxyQuery, signSessionToken } from "../src/auth/crypto";
import type { Config } from "../src/config";
import type { AppDeps } from "../src/context";
import { createPrisma } from "../src/db";
import { FakeShopify } from "../src/shopify/fake";
import { HITS_FILE } from "./global-setup";
import { hasOperation, validateResponse } from "./openapi";

export const SECRET = "test-secret-not-real";
export const API_KEY = "test-client-id";
export const SHOP = "dsg-test.myshopify.com";

export const CUSTOMER_A = "gid://shopify/Customer/1001"; // Acme, location 1
export const CUSTOMER_A2 = "gid://shopify/Customer/1002"; // Acme, location 1 (colleague)
export const CUSTOMER_A_LOC2 = "gid://shopify/Customer/1003"; // Acme, location 2 only
export const CUSTOMER_B = "gid://shopify/Customer/2001"; // Other Co, location 3
export const CUSTOMER_NO_COMPANY = "gid://shopify/Customer/9999";
export const LOC1 = "gid://shopify/CompanyLocation/1";
export const LOC2 = "gid://shopify/CompanyLocation/2";
export const LOC3 = "gid://shopify/CompanyLocation/3";

export const V_COSTLY = "gid://shopify/ProductVariant/1"; // price 100.00, cost 90.00 (10% margin)
export const V_GOOD = "gid://shopify/ProductVariant/2"; // price 50.00, cost 20.00 (60% margin)
export const V_NOCOST = "gid://shopify/ProductVariant/3"; // price 10.00, cost unknown

export const STAFF_REP = "5001";
export const STAFF_MANAGER = "5002";

export function testConfig(): Config {
  return {
    nodeEnv: "test",
    port: 0,
    host: "127.0.0.1",
    shopDomain: SHOP,
    apiKey: API_KEY,
    apiSecret: SECRET,
    appPublicUrl: "https://dsg-test.myshopify.com/apps/quotes",
    defaultExpiryDays: 14,
    signatureMaxAgeSeconds: 300,
    attachments: null,
  };
}

export function customerToken(customerId: string, now = new Date()): string {
  const t = Math.floor(now.getTime() / 1000);
  return signSessionToken(
    { iss: "https://shopify.com/123", dest: `https://${SHOP}`, aud: API_KEY, sub: customerId, exp: t + 60, nbf: t - 5, iat: t },
    SECRET,
  );
}

export function staffToken(userId: string, now = new Date()): string {
  const t = Math.floor(now.getTime() / 1000);
  return signSessionToken(
    { iss: `https://${SHOP}/admin`, dest: `https://${SHOP}`, aud: API_KEY, sub: userId, exp: t + 60, nbf: t - 5, iat: t },
    SECRET,
  );
}

export function seedFakeShopify(): FakeShopify {
  const s = new FakeShopify();
  s.addBuyer({ customerId: CUSTOMER_A, name: "Dana Dealer", companyId: "gid://shopify/Company/1", companyName: "Acme Dealers", companyLocationId: LOC1, locations: [{ id: LOC1, name: "Main" }] });
  s.addBuyer({ customerId: CUSTOMER_A2, name: "Drew Dealer", companyId: "gid://shopify/Company/1", companyName: "Acme Dealers", companyLocationId: LOC1, locations: [{ id: LOC1, name: "Main" }] });
  s.addBuyer({ customerId: CUSTOMER_A_LOC2, name: "Lou Branch", companyId: "gid://shopify/Company/1", companyName: "Acme Dealers", companyLocationId: LOC2, locations: [{ id: LOC2, name: "Branch" }] });
  s.addBuyer({ customerId: CUSTOMER_B, name: "Bea Buyer", companyId: "gid://shopify/Company/2", companyName: "Other Co", companyLocationId: LOC3, locations: [{ id: LOC3, name: "HQ" }] });
  s.addVariant({ variantId: V_COSTLY, price: "100.00", unitCost: "90.00", title: "Costly Widget" });
  s.addVariant({ variantId: V_GOOD, price: "50.00", unitCost: "20.00", title: "Good Widget" });
  s.addVariant({ variantId: V_NOCOST, price: "10.00", unitCost: null, title: "No-cost Widget" });
  return s;
}

export interface Harness {
  app: FastifyInstance;
  deps: AppDeps;
  prisma: PrismaClient;
  shopify: FakeShopify;
  clock: { now: Date };
  /** Make a request as a customer (Bearer customer-account token) or as staff. */
  c: Caller;
  proxy: Caller;
  s: Caller;
  asCustomer(customerId: string): Caller;
  asStaff(userId: string): Caller;
  raw(opts: { method: string; url: string; headers?: Record<string, string>; payload?: string | Buffer }): Promise<{ status: number; body: any; headers: Record<string, any> }>;
}

export interface Caller {
  get(url: string): Promise<Res>;
  post(url: string, body?: unknown): Promise<Res>;
  put(url: string, body?: unknown): Promise<Res>;
  patch(url: string, body?: unknown): Promise<Res>;
  del(url: string): Promise<Res>;
}
export interface Res {
  status: number;
  body: any;
  text: string;
  headers: Record<string, any>;
}

const TABLES = [
  "Event", "Message", "QuoteLine", "QuoteVersion", "Quote", "Job", "NotificationPref", "CustomerProfile",
  "ActiveQuote", "Counter", "WebhookReceipt", "Staff", "Session",
];

/** Call inside a describe(): sets up an app on the test DB, wipes tables before each test. */
export function useHarness(): Harness {
  const h = {} as Harness;
  const clock = { now: new Date("2026-03-02T15:00:00.000Z") };

  beforeAll(async () => {
    const prisma = createPrisma(process.env.TEST_DATABASE_URL!);
    const shopify = seedFakeShopify();
    const deps: AppDeps = { config: testConfig(), prisma, shopify, attachments: new FakeAttachmentSigner(), now: () => new Date(clock.now) };
    const app = await buildApp(deps, {
      exposeRoute: true,
      onResponse: (method, url, status) => appendFileSync(HITS_FILE, JSON.stringify({ method, url, status }) + "\n"),
    });
    await app.ready();
    Object.assign(h, { app, deps, prisma, shopify, clock });

    const send = async (o: { method: string; url: string; headers?: Record<string, string>; payload?: string | Buffer }) => {
      const r = await app.inject({ method: o.method as any, url: o.url, headers: o.headers, payload: o.payload as any });
      let body: any = undefined;
      try {
        body = r.body ? JSON.parse(r.body) : undefined;
      } catch {
        body = undefined;
      }
      // Every response is checked against docs/openapi.yaml (unknown keys, missing required keys, types, enums).
      const pattern = r.headers["x-route-pattern"];
      if (typeof pattern === "string" && pattern && hasOperation(o.method, pattern)) {
        const errs = validateResponse(o.method, pattern, r.statusCode, body);
        if (errs.length) throw new Error(`Response of ${o.method} ${pattern} (${r.statusCode}) violates docs/openapi.yaml:\n  ${errs.slice(0, 8).join("\n  ")}`);
      }
      return { status: r.statusCode, body, text: r.body, headers: r.headers as Record<string, any> };
    };
    h.raw = send;
    const caller = (headers: () => Record<string, string>, urlFn: (u: string, method: string) => string = (u) => u): Caller => {
      const mk = (method: string) => (url: string, body?: unknown) =>
        send({
          method,
          url: urlFn(url, method),
          headers: { ...headers(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
          payload: body !== undefined ? JSON.stringify(body) : undefined,
        });
      return { get: mk("GET"), post: mk("POST"), put: mk("PUT"), patch: mk("PATCH"), del: mk("DELETE") };
    };
    h.asCustomer = (id) => caller(() => ({ authorization: `Bearer ${customerToken(id, clock.now)}` }));
    h.asStaff = (id) => caller(() => ({ authorization: `Bearer ${staffToken(id, clock.now)}` }));
    h.c = h.asCustomer(CUSTOMER_A);
    h.s = h.asStaff(STAFF_REP);
    // App proxy flavour for a given customer: /apps/quotes/c/... arrives as /proxy/c/... with a signed query.
    h.proxy = caller(
      () => ({}),
      (u) => {
        const [path, q = ""] = u.split("?");
        const extra = Object.fromEntries(new URLSearchParams(q));
        const signed = signAppProxyQuery({ shop: SHOP, logged_in_customer_id: CUSTOMER_A.split("/").pop()!, path_prefix: "/apps/quotes", ...extra }, SECRET, clock.now);
        return `/proxy${path}?${signed}`;
      },
    );
  });

  beforeEach(async () => {
    clock.now = new Date("2026-03-02T15:00:00.000Z");
    await h.prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
    h.shopify.createdDraftOrders.length = 0;
    h.shopify.completedDraftOrders.length = 0;
    h.shopify.deletedDraftOrders.length = 0;
    h.shopify.failNextCreate = null;
    h.shopify.variants.clear();
    seedFakeShopify().variants.forEach((v, k) => h.shopify.variants.set(k, v));
    h.shopify.buyers.get(CUSTOMER_A)!.paymentTermsTemplateId = null;
  });

  afterAll(async () => {
    await h.app.close();
    await h.prisma.$disconnect();
  });
  return h;
}

// ---------------------------------------------------------------- scenario helpers
/** Staff members used across tests; created lazily by the first authenticated call, then promoted. */
export async function ensureStaff(h: Harness, userId: string, patch: { isManager?: boolean; name?: string; priceFloorPct?: number } = {}) {
  await h.asStaff(userId).get("/s/reports/summary"); // auto-provisions the Staff row
  return h.prisma.staff.update({
    where: { shop_shopifyStaffId: { shop: SHOP, shopifyStaffId: userId } },
    data: { name: patch.name ?? `Staff ${userId}`, isManager: patch.isManager, ...(patch.priceFloorPct !== undefined ? { priceFloorPct: patch.priceFloorPct } : {}) },
  });
}

/** Draft quote with lines, as customer A. Returns the CustomerQuote. */
export async function draftWith(h: Harness, lines: { variantId: string; qty: number }[] = [{ variantId: V_GOOD, qty: 2 }], c: Caller = h.c) {
  const created = await c.post("/c/quotes", { title: "Test quote", newJob: { name: "Job One", poNumber: "PO-1" } });
  if (created.status !== 201) throw new Error("create failed " + created.text);
  let q = created.body;
  for (const l of lines) {
    const r = await c.post(`/c/quotes/${q.id}/lines`, l);
    if (r.status !== 201) throw new Error("add line failed " + r.text);
    q = r.body;
  }
  return q;
}

export async function submitted(h: Harness, lines?: { variantId: string; qty: number }[]) {
  const q = await draftWith(h, lines);
  const r = await h.c.post(`/c/quotes/${q.id}/submit`, {});
  if (r.status !== 200) throw new Error("submit failed " + r.text);
  return r.body;
}

/** SUBMITTED -> claimed -> sent (v1) by the rep. Returns the customer's view. */
export async function sent(h: Harness, lines?: { variantId: string; qty: number }[], repPrices?: Record<string, string>) {
  const q = await submitted(h, lines);
  await ensureStaff(h, STAFF_REP);
  const claimed = await h.s.post(`/s/quotes/${q.id}/claim`);
  if (claimed.status !== 200) throw new Error("claim failed " + claimed.text);
  if (repPrices) {
    const wl = claimed.body.workingLines.map((l: any) => ({ id: l.id, variantId: l.variantId, qty: l.qty, quotedPrice: repPrices[l.variantId] ?? l.quotedPrice }));
    const saved = await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: wl });
    if (saved.status !== 200) throw new Error("save failed " + saved.text);
  }
  const r = await h.s.post(`/s/quotes/${q.id}/send`);
  if (r.status !== 200) throw new Error("send failed " + r.text);
  return (await h.c.get(`/c/quotes/${q.id}`)).body;
}

export async function accepted(h: Harness, lines?: { variantId: string; qty: number }[]) {
  const q = await sent(h, lines);
  const r = await h.c.post(`/c/quotes/${q.id}/accept`, { versionNo: q.currentVersion });
  if (r.status !== 200) throw new Error("accept failed " + r.text);
  return r.body;
}

export const eventsOf = (h: Harness, quoteId: string, type?: string) =>
  h.prisma.event.findMany({ where: { quoteId, ...(type ? { type } : {}) }, orderBy: { createdAt: "asc" } });
