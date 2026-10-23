import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AccountInfo, ActivityPage, PdfLink, StatementSummary } from "@dsg/contracts";
import { DEALER_A, DEALER_B, FakeZoho } from "@dsg/testkit";
import { AccountMapRepo, signWebhook, syncCustomer } from "@dsg/statement";
import { ShopifyBuyerResolver, type ShopifyAdmin, ACCOUNT_INFO_QUERY, RESOLVE_BUYER_QUERY } from "@dsg/identity";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { FakeAttachmentSigner } from "../src/attachments";
import { createPrisma } from "../src/db";
import type { StatementDeps } from "../src/statement/deps";
import { FakeShopify } from "../src/shopify/fake";
import { signAppProxyQuery } from "../src/auth/crypto";
import { API_KEY, SHOP, SECRET, testConfig, customerToken } from "./helpers";

/**
 * Account pages (/a): statement + account info for the customer-account extensions. Real routes, real Postgres
 * (statement tables come from the Prisma migration), real ShopifyBuyerResolver; only Zoho and the Shopify Admin
 * API are faked. Every route has a success and a failure test.
 */

const ADMIN_A = "gid://shopify/Customer/7001"; // Location admin of dealer A
const ADMIN_B = "gid://shopify/Customer/7002"; // Location admin of dealer B
const MEMBER_A = "gid://shopify/Customer/7003"; // plain member of dealer A (no Location admin role)
const UNMAPPED = "gid://shopify/Customer/7004"; // Location admin of a company with no account_map row
const TWO_COMPANIES = "gid://shopify/Customer/7005"; // two company profiles: ambiguous, denied

const profile = (companyId: string, externalId: string | null, roles: string[]) => ({
  id: `${companyId}/profile`, company: { id: companyId, name: "x", externalId },
  roleAssignments: { nodes: roles.map((name) => ({ role: { name } })) },
});
const customers: Record<string, unknown> = {
  [ADMIN_A]: { id: ADMIN_A, companyContactProfiles: [profile(DEALER_A.companyId, DEALER_A.number, ["Location admin"])] },
  [ADMIN_B]: { id: ADMIN_B, companyContactProfiles: [profile(DEALER_B.companyId, DEALER_B.number, ["Location admin"])] },
  [MEMBER_A]: { id: MEMBER_A, companyContactProfiles: [profile(DEALER_A.companyId, DEALER_A.number, ["Ordering only"])] },
  [UNMAPPED]: { id: UNMAPPED, companyContactProfiles: [profile("gid://shopify/Company/999", "CUS-9999", ["Location admin"])] },
  [TWO_COMPANIES]: { id: TWO_COMPANIES, companyContactProfiles: [profile(DEALER_A.companyId, DEALER_A.number, ["Location admin"]), profile(DEALER_B.companyId, DEALER_B.number, ["Location admin"])] },
};
const addr = { address1: "1 Main St", address2: null, city: "Denver", zoneCode: "CO", zip: "80202", countryCode: "US", phone: "555-0100" };
const companies: Record<string, unknown> = {
  [DEALER_A.companyId]: {
    id: DEALER_A.companyId, name: DEALER_A.name, externalId: DEALER_A.number,
    locations: { nodes: [{ id: "gid://shopify/CompanyLocation/11", name: "Denver", billingAddress: addr, shippingAddress: null }] },
    contacts: { nodes: [
      { title: "Owner", isMainContact: true, customer: { displayName: "Dana Dealer", email: "dana@a.test" }, roleAssignments: { nodes: [{ role: { name: "Location admin" } }, { role: { name: "Location admin" } }] } },
      { title: null, isMainContact: false, customer: { displayName: "", email: "buyer@a.test" }, roleAssignments: { nodes: [] } },
    ] },
  },
  [DEALER_B.companyId]: { id: DEALER_B.companyId, name: DEALER_B.name, externalId: DEALER_B.number, locations: { nodes: [] }, contacts: { nodes: [] } },
};
let adminCalls: { query: string; variables: Record<string, unknown> }[] = [];
const fakeAdmin: ShopifyAdmin = {
  async graphql(query, variables) {
    adminCalls.push({ query, variables });
    if (query === RESOLVE_BUYER_QUERY) return { customer: customers[variables.id as string] ?? null } as never;
    if (query === ACCOUNT_INFO_QUERY) return { company: companies[variables.id as string] ?? null } as never;
    throw new Error("unexpected query");
  },
};

const WEBHOOK_SECRET = "zoho-secret-not-real";
let pool: pg.Pool;
let app: FastifyInstance;
let bare: FastifyInstance; // same API without statement deps
let zoho: FakeZoho;
let queued: string[] = [];
let clock = new Date("2026-10-22T15:00:00.000Z");

function deps(rateLimit?: { max: number; windowMs: number }): StatementDeps {
  return {
    pool, zoho, admin: fakeAdmin,
    resolver: new ShopifyBuyerResolver({ apiKey: API_KEY, apiSecret: testConfig().apiSecret, allowedShops: [SHOP], admin: fakeAdmin, accountMap: new AccountMapRepo(pool), log: () => {}, now: () => clock.getTime() }),
    queue: { enqueueSync: async (id: string) => { queued.push(id); } },
    publicBaseUrl: "https://api.test",
    webhookSecret: WEBHOOK_SECRET,
    rateLimit,
  };
}
const build = async (s?: StatementDeps) => {
  const a = await buildApp({ config: testConfig(), prisma: createPrisma(process.env.TEST_DATABASE_URL!), shopify: new FakeShopify(), attachments: new FakeAttachmentSigner(), now: () => clock, statement: s });
  await a.ready();
  return a;
};
const get = (url: string, customer?: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url, headers: { ...(customer ? { authorization: `Bearer ${customerToken(customer, clock)}` } : {}), ...headers } });
const post = (url: string, customer: string, payload: unknown = {}) =>
  app.inject({ method: "POST", url, headers: { authorization: `Bearer ${customerToken(customer, clock)}` }, payload: payload as never });

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  zoho = new FakeZoho();
  app = await build(deps());
  bare = await build();
});
afterAll(async () => {
  await app.close();
  await bare.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate account_map, zoho_contact, zoho_document, pdf_link, sync_event, access_audit");
  zoho.failNext = 0;
  queued = [];
  adminCalls = [];
  clock = new Date("2026-10-22T15:00:00.000Z");
});
const mapBoth = async () => {
  const repo = new AccountMapRepo(pool);
  for (const d of [DEALER_A, DEALER_B]) await repo.upsert({ shopifyCompanyId: d.companyId, zohoCustomerId: d.zohoId, customerNumber: d.number, displayName: d.name });
};
const syncBoth = async () => {
  await mapBoth();
  for (const d of [DEALER_A, DEALER_B]) await syncCustomer({ pool, zoho }, d.zohoId);
};

describe("feature switch", () => {
  it("does not mount /a or /webhooks/zoho without statement deps", async () => {
    expect((await bare.inject({ method: "GET", url: "/a/v1/account" })).statusCode).toBe(404);
    expect((await bare.inject({ method: "POST", url: "/webhooks/zoho", payload: "{}" })).statusCode).toBe(404);
  });
  it("the statement tables are created by the Prisma migration with the same DDL the package tests use", () => {
    const strip = (s: string) => s.split("\n").filter((l) => !l.startsWith("--")).join("\n").trim();
    const migration = readFileSync(join(__dirname, "..", "prisma", "migrations", "20261023000000_statement_tables", "migration.sql"), "utf8");
    const source = readFileSync(join(__dirname, "..", "..", "..", "packages", "statement", "migrations", "001_statement_tables.sql"), "utf8");
    expect(strip(migration)).toBe(strip(source));
  });
});

describe("authentication and tenant scoping", () => {
  it("401 without or with a bad token on every JSON route", async () => {
    await syncBoth();
    for (const [m, u] of [["GET", "/a/v1/statement/summary"], ["GET", "/a/v1/statement/activity"], ["POST", "/a/v1/statement/pdf-link"], ["POST", "/a/v1/invoices/I-1/pdf-link"], ["GET", "/a/v1/account"]] as const) {
      expect((await app.inject({ method: m, url: u })).statusCode, `${m} ${u} no token`).toBe(401);
      expect((await app.inject({ method: m, url: u, headers: { authorization: "Bearer not.a.jwt" } })).statusCode, `${m} ${u} bad token`).toBe(401);
    }
  });
  it("403 for a plain member, an unmapped company and a contact with two companies; each denial is audited", async () => {
    await syncBoth();
    for (const who of [MEMBER_A, UNMAPPED, TWO_COMPANIES]) expect((await get("/a/v1/statement/summary", who)).statusCode, who).toBe(403);
    const { rows } = await pool.query("select outcome from access_audit where action like 'GET %' and outcome = 'denied'");
    expect(rows).toHaveLength(3);
  });
  it("403 after a mapping is deactivated", async () => {
    await syncBoth();
    await new AccountMapRepo(pool).deactivate(DEALER_A.companyId);
    expect((await get("/a/v1/statement/summary", ADMIN_A)).statusCode).toBe(403);
    expect((await get("/a/v1/statement/summary", ADMIN_B)).statusCode).toBe(200);
  });
  it("403 when the Shopify company external id no longer matches the mapped customer number", async () => {
    await syncBoth();
    await pool.query("update account_map set customer_number = 'CUS-OTHER' where shopify_company_id = $1", [DEALER_A.companyId]);
    expect((await get("/a/v1/statement/summary", ADMIN_A)).statusCode).toBe(403);
  });
  it("a buyer only ever sees their own company, whatever the request carries", async () => {
    await syncBoth();
    const a = await get(`/a/v1/statement/activity?zohoCustomerId=${DEALER_B.zohoId}&companyId=${DEALER_B.companyId}`, ADMIN_A, { "x-company-id": DEALER_B.companyId });
    expect(a.statusCode).toBe(200);
    const ids = ActivityPage.parse(a.json()).items.map((i) => i.number);
    expect(ids).toContain("INV-0001");
    expect(ids).not.toContain("INV-0003");
    const b = ActivityPage.parse((await get("/a/v1/statement/activity", ADMIN_B)).json());
    expect(b.items.map((i) => i.number)).toEqual(["INV-0003"]);
    const acct = AccountInfo.parse((await get(`/a/v1/account?companyId=${DEALER_B.companyId}`, ADMIN_A)).json());
    expect(acct.companyName).toBe(DEALER_A.name);
    expect(adminCalls.filter((c) => c.query === ACCOUNT_INFO_QUERY).map((c) => c.variables.id)).toEqual([DEALER_A.companyId]);
  });
});

describe("GET /a/v1/statement/summary", () => {
  it("returns the cached Zoho figures", async () => {
    await syncBoth();
    const r = await get("/a/v1/statement/summary", ADMIN_A);
    expect(r.statusCode).toBe(200);
    const s = StatementSummary.parse(r.json());
    expect(s).toMatchObject({ customerName: DEALER_A.name, customerNumber: DEALER_A.number, outstanding: "1250.50", overdue: "800.50", creditLimit: "10000.00", paymentTerms: "Net 30", currency: "USD" });
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  });
  it("503 and a sync request when the customer has never been synced", async () => {
    await mapBoth();
    const r = await get("/a/v1/statement/summary", ADMIN_A);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: "Service unavailable" });
    expect(queued).toEqual([DEALER_A.zohoId]);
  });
});

describe("GET /a/v1/statement/activity", () => {
  it("filters, searches and rejects bad input with 400", async () => {
    await syncBoth();
    const all = ActivityPage.parse((await get("/a/v1/statement/activity", ADMIN_A)).json());
    expect(all.items.map((i) => i.kind).sort()).toEqual(["invoice", "invoice", "payment", "sales_order"]);
    const inv = ActivityPage.parse((await get("/a/v1/statement/activity?type=invoice", ADMIN_A)).json());
    expect(inv.items.every((i) => i.kind === "invoice")).toBe(true);
    const po = ActivityPage.parse((await get("/a/v1/statement/activity?search=PO-77", ADMIN_A)).json());
    expect(po.items.map((i) => i.number)).toEqual(["INV-0001"]);
    const page1 = ActivityPage.parse((await get("/a/v1/statement/activity?limit=2", ADMIN_A)).json());
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = ActivityPage.parse((await get(`/a/v1/statement/activity?limit=2&cursor=${page1.nextCursor}`, ADMIN_A)).json());
    expect(page2.items).toHaveLength(2);
    for (const bad of ["type=nope", "from=2026-02-31", "from=2026-10-02&to=2026-10-01", "limit=0", "limit=101", "cursor=%25%25"]) {
      expect((await get(`/a/v1/statement/activity?${bad}`, ADMIN_A)).statusCode, bad).toBe(400);
    }
  });
});

describe("PDF links and downloads", () => {
  it("a statement link downloads once, then 404", async () => {
    await syncBoth();
    const r = await post("/a/v1/statement/pdf-link", ADMIN_A, { from: "2026-01-01", to: "2026-10-22" });
    expect(r.statusCode).toBe(200);
    const link = PdfLink.parse(r.json());
    expect(link.url).toMatch(/^https:\/\/api\.test\/a\/files\/[A-Za-z0-9_-]{20,}$/);
    const path = new URL(link.url).pathname;
    const f = await app.inject({ method: "GET", url: path });
    expect(f.statusCode).toBe(200);
    expect(f.headers["content-type"]).toBe("application/pdf");
    expect(f.headers["content-disposition"]).toContain("statement-2026-01-01-to-2026-10-22.pdf");
    expect(f.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
    expect(f.rawPayload.subarray(0, 4).toString()).toBe("%PDF");
    expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(404);
  });
  it("rejects an inverted, oversized or malformed range", async () => {
    await syncBoth();
    for (const body of [{ from: "2026-10-02", to: "2026-10-01" }, { from: "2020-01-01", to: "2026-10-01" }, { from: "nope" }]) {
      expect((await post("/a/v1/statement/pdf-link", ADMIN_A, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });
  it("an invoice link works for own invoices only", async () => {
    await syncBoth();
    expect((await post("/a/v1/invoices/I-1/pdf-link", ADMIN_A)).statusCode).toBe(200);
    expect((await post("/a/v1/invoices/I-3/pdf-link", ADMIN_A)).statusCode).toBe(404); // dealer B's invoice
    expect((await post("/a/v1/invoices/bad%20id/pdf-link", ADMIN_A)).statusCode).toBe(400);
  });
  it("a token is handed back when Zoho fails, so a retry still works", async () => {
    await syncBoth();
    const failing = await build({ ...deps(), zoho: Object.assign(new FakeZoho(), { getInvoicePdf: async () => { throw new Error("zoho down"); } }) });
    try {
      const link = PdfLink.parse((await failing.inject({ method: "POST", url: "/a/v1/invoices/I-1/pdf-link", headers: { authorization: `Bearer ${customerToken(ADMIN_A, clock)}` }, payload: {} })).json());
      const path = new URL(link.url).pathname;
      expect((await failing.inject({ method: "GET", url: path })).statusCode).toBe(503);
      expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(200); // same token, healthy Zoho
    } finally {
      await failing.close();
    }
  });
  it("an unknown or malformed token is 404", async () => {
    expect((await app.inject({ method: "GET", url: "/a/files/short" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/a/files/${"a".repeat(40)}` })).statusCode).toBe(404);
  });
});

describe("GET /a/v1/account", () => {
  it("joins the Shopify company profile with the cached Zoho terms", async () => {
    await syncBoth();
    const r = await get("/a/v1/account", ADMIN_A);
    expect(r.statusCode).toBe(200);
    const a = AccountInfo.parse(r.json());
    expect(a).toMatchObject({ companyName: DEALER_A.name, customerNumber: DEALER_A.number, currency: "USD", paymentTerms: "Net 30", creditLimit: "10000.00" });
    expect(a.zohoAsOf).toBeTruthy();
    expect(a.locations).toEqual([{ id: "gid://shopify/CompanyLocation/11", name: "Denver", billingAddress: { address1: "1 Main St", address2: null, city: "Denver", province: "CO", zip: "80202", country: "US", phone: "555-0100" }, shippingAddress: null }]);
    expect(a.contacts).toEqual([
      { name: "Dana Dealer", email: "dana@a.test", title: "Owner", isMainContact: true, roles: ["Location admin"] },
      { name: "buyer@a.test", email: "buyer@a.test", title: null, isMainContact: false, roles: [] },
    ]);
  });
  it("still works before the first Zoho sync, with the Zoho fields empty", async () => {
    await mapBoth();
    const a = AccountInfo.parse((await get("/a/v1/account", ADMIN_A)).json());
    expect(a).toMatchObject({ companyName: DEALER_A.name, currency: null, paymentTerms: null, creditLimit: null, zohoAsOf: null });
  });
  it("503 when Shopify has no such company", async () => {
    await mapBoth();
    delete companies[DEALER_B.companyId];
    try {
      expect((await get("/a/v1/account", ADMIN_B)).statusCode).toBe(503);
    } finally {
      companies[DEALER_B.companyId] = { id: DEALER_B.companyId, name: DEALER_B.name, externalId: DEALER_B.number, locations: { nodes: [] }, contacts: { nodes: [] } };
    }
  });
});

describe("rate limiting", () => {
  it("429 with retry-after past the per-customer limit", async () => {
    await syncBoth();
    const limited = await build(deps({ max: 2, windowMs: 60_000 }));
    try {
      const call = () => limited.inject({ method: "GET", url: "/a/v1/statement/summary", headers: { authorization: `Bearer ${customerToken(ADMIN_A, clock)}` } });
      expect((await call()).statusCode).toBe(200);
      expect((await call()).statusCode).toBe(200);
      const third = await call();
      expect(third.statusCode).toBe(429);
      expect(third.headers["retry-after"]).toBe("60");
    } finally {
      await limited.close();
    }
  });
});

describe("CORS for the extension", () => {
  it("answers a preflight on /a/v1/* without authentication and echoes the (possibly null) origin", async () => {
    for (const origin of ["null", "https://extensions.shopifycdn.com"]) {
      const r = await app.inject({ method: "OPTIONS", url: "/a/v1/account", headers: { origin, "access-control-request-method": "GET" } });
      expect(r.statusCode).toBe(204);
      expect(r.headers["access-control-allow-origin"]).toBe(origin);
      expect(r.headers["access-control-allow-headers"]).toContain("Authorization");
      expect(r.headers["access-control-allow-credentials"]).toBeUndefined();
    }
  });
  it("adds CORS headers to real responses and none to the PDF download", async () => {
    await syncBoth();
    const r = await get("/a/v1/statement/summary", ADMIN_A, { origin: "null" });
    expect(r.headers["access-control-allow-origin"]).toBe("null");
    const f = await app.inject({ method: "GET", url: "/a/files/abc", headers: { origin: "null" } });
    expect(f.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("POST /webhooks/zoho", () => {
  const body = JSON.stringify({ invoice: { customer_id: DEALER_A.zohoId } });
  it("queues a sync for a mapped customer when the signature is valid", async () => {
    await mapBoth();
    const r = await app.inject({ method: "POST", url: "/webhooks/zoho", headers: { "content-type": "application/json", "x-zoho-webhook-signature": signWebhook(body, WEBHOOK_SECRET) }, payload: body });
    expect(r.statusCode).toBe(200);
    expect(queued).toEqual([DEALER_A.zohoId]);
  });
  it("ignores unmapped customers and malformed bodies (still 200, nothing queued)", async () => {
    await mapBoth();
    for (const payload of [JSON.stringify({ customer_id: "UNKNOWN" }), "not json"]) {
      const r = await app.inject({ method: "POST", url: "/webhooks/zoho", headers: { "content-type": "application/json", "x-zoho-webhook-signature": signWebhook(payload, WEBHOOK_SECRET) }, payload });
      expect(r.statusCode).toBe(200);
    }
    expect(queued).toEqual([]);
  });
  it("401 for a missing, wrong or tampered signature", async () => {
    await mapBoth();
    const headers = { "content-type": "application/json" };
    expect((await app.inject({ method: "POST", url: "/webhooks/zoho", headers, payload: body })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/webhooks/zoho", headers: { ...headers, "x-zoho-webhook-signature": signWebhook(body, "wrong") }, payload: body })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/webhooks/zoho", headers: { ...headers, "x-zoho-webhook-signature": signWebhook(body, WEBHOOK_SECRET) }, payload: body + " " })).statusCode).toBe(401);
    expect(queued).toEqual([]);
  });
});


describe("storefront pages through the app proxy (/proxy/a)", () => {
  const signed = (path: string, q: Record<string, string> = {}, at = clock) =>
    `/proxy/a${path}${path.includes("?") ? "&" : "?"}${signAppProxyQuery({ shop: SHOP, path_prefix: "/apps/quotes", ...q }, SECRET, at)}`;
  const as = (customerNumericId: string, path: string, extra: Record<string, string> = {}) =>
    app.inject({ method: "GET", url: signed(path, { logged_in_customer_id: customerNumericId, ...extra }) });

  it("serves the same data as /a, for the signed-in customer only", async () => {
    await syncBoth();
    const viaProxy = await as("7001", "/v1/statement/summary");
    const direct = await get("/a/v1/statement/summary", ADMIN_A);
    expect(viaProxy.statusCode).toBe(200);
    expect(StatementSummary.parse(viaProxy.json())).toEqual(StatementSummary.parse(direct.json()));
    const b = await as("7002", "/v1/statement/summary");
    expect(b.statusCode).toBe(200);
    expect(b.json()).not.toEqual(viaProxy.json());
    expect(ActivityPage.safeParse((await as("7001", "/v1/statement/activity")).json()).success).toBe(true);
    const acct = await as("7001", "/v1/account");
    expect(AccountInfo.parse(acct.json()).customerNumber).toBe(DEALER_A.number);
  });
  it("a customer id chosen by the browser changes nothing: it is never read", async () => {
    await syncBoth();
    const r = await as("7001", "/v1/statement/summary", { customer: "7002", zoho_customer_id: DEALER_B.zohoId, company: DEALER_B.companyId });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual((await as("7001", "/v1/statement/summary")).json());
  });
  it("401 without a signature, with a bad or tampered one, when stale, for another shop, or signed out", async () => {
    await syncBoth();
    const p = "/v1/statement/summary";
    expect((await app.inject({ method: "GET", url: `/proxy/a${p}` })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/proxy/a${p}?logged_in_customer_id=7001&signature=deadbeef` })).statusCode).toBe(401);
    const tampered = signed(p, { logged_in_customer_id: "7001" }).replace("logged_in_customer_id=7001", "logged_in_customer_id=7002");
    expect((await app.inject({ method: "GET", url: tampered })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: signed(p, { logged_in_customer_id: "7001" }, new Date(clock.getTime() - 3600_000)) })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: signed(p, { logged_in_customer_id: "7001", shop: "other.myshopify.com" }) })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: signed(p, { logged_in_customer_id: "" }) })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: signed(p, { logged_in_customer_id: "not-a-number" }) })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: signed(p) })).statusCode).toBe(401);
  });
  it("keeps the company rules: plain member, unmapped company and two-company contact are 403", async () => {
    await syncBoth();
    for (const id of ["7003", "7004", "7005"]) expect((await as(id, "/v1/statement/summary")).statusCode, id).toBe(403);
  });
  it("does not accept a session token, and /a does not accept a proxy signature", async () => {
    await syncBoth();
    const r = await app.inject({ method: "GET", url: "/proxy/a/v1/statement/summary", headers: { authorization: `Bearer ${customerToken(ADMIN_A, clock)}` } });
    expect(r.statusCode).toBe(401);
    const q = signAppProxyQuery({ shop: SHOP, logged_in_customer_id: "7001" }, SECRET, clock);
    expect((await app.inject({ method: "GET", url: `/a/v1/statement/summary?${q}` })).statusCode).toBe(401);
  });
  it("sends no CORS headers and issues PDF links that download from /a/files", async () => {
    await syncBoth();
    const r = await app.inject({ method: "GET", url: signed("/v1/statement/summary", { logged_in_customer_id: "7001" }), headers: { origin: "https://evil.test" } });
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    const link = await app.inject({ method: "POST", url: signed("/v1/statement/pdf-link", { logged_in_customer_id: "7001" }), payload: {} });
    expect(link.statusCode).toBe(200);
    const url = PdfLink.parse(link.json()).url;
    expect(url.startsWith("https://api.test/a/files/")).toBe(true);
    const file = await app.inject({ method: "GET", url: url.replace("https://api.test", "") });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toContain("application/pdf");
    expect((await app.inject({ method: "GET", url: signed("/files/abcdefghijklmnopqrstuvwxyz", { logged_in_customer_id: "7001" }) })).statusCode).toBe(404);
  });
  it("invoice PDF link is scoped to the signed-in company", async () => {
    await syncBoth();
    const { rows } = await pool.query("select id from zoho_document where zoho_customer_id = $1 and kind = 'invoice' and source = 'zoho' limit 1", [DEALER_A.zohoId]);
    const id = rows[0].id;
    const ok = await app.inject({ method: "POST", url: signed(`/v1/invoices/${id}/pdf-link`, { logged_in_customer_id: "7001" }), payload: {} });
    expect(ok.statusCode).toBe(200);
    const other = await app.inject({ method: "POST", url: signed(`/v1/invoices/${id}/pdf-link`, { logged_in_customer_id: "7002" }), payload: {} });
    expect(other.statusCode).toBe(404);
  });
});
