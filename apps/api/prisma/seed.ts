/**
 * Dev/demo seed: 3 companies, 3 staff, 12 quotes covering ALL 10 statuses (the issue says "8 quotes"; there are
 * 10 statuses, so 12 are created to cover every one plus a v2 revision and a below-floor example).
 *
 * Everything goes through the real HTTP API of an in-process app (fake Shopify gateway, signed fake tokens), so
 * every status is reached via transition() with its events row. FAKE DATA ONLY (CLAUDE.md rule 8).
 *
 *   pnpm -F api db:seed            # refuses if quotes already exist
 *   pnpm -F api db:seed -- --reset # wipes quote data first
 */
import { pathToFileURL } from "node:url";
import type { PrismaClient } from "@prisma/client";
import { buildApp } from "../src/app";
import { FakeAttachmentSigner } from "../src/attachments";
import { signSessionToken, signShopifyWebhook } from "../src/auth/crypto";
import { loadConfig, type Config } from "../src/config";
import { createPrisma } from "../src/db";
import { FakeShopify } from "../src/shopify/fake";

export const SEED_BUYERS = {
  acme: { customerId: "gid://shopify/Customer/9101", name: "Dana Dealer", email: "dana@acme.example.test", companyId: "gid://shopify/Company/9001", companyName: "Acme Dealers", locationId: "gid://shopify/CompanyLocation/9001" },
  acme2: { customerId: "gid://shopify/Customer/9102", name: "Drew Dealer", email: "drew@acme.example.test", companyId: "gid://shopify/Company/9001", companyName: "Acme Dealers", locationId: "gid://shopify/CompanyLocation/9001" },
  summit: { customerId: "gid://shopify/Customer/9201", name: "Sam Summit", email: "sam@summit.example.test", companyId: "gid://shopify/Company/9002", companyName: "Summit Builders", locationId: "gid://shopify/CompanyLocation/9002" },
  lakeside: { customerId: "gid://shopify/Customer/9301", name: "Lee Lakeside", email: "lee@lakeside.example.test", companyId: "gid://shopify/Company/9003", companyName: "Lakeside Supply", locationId: "gid://shopify/CompanyLocation/9003" },
} as const;

const VARIANTS = [
  { variantId: "gid://shopify/ProductVariant/9001", title: "Oak Door 32in", price: "240.00", unitCost: "150.00" },
  { variantId: "gid://shopify/ProductVariant/9002", title: "Hinge Set (3pk)", price: "18.50", unitCost: "9.00" },
  { variantId: "gid://shopify/ProductVariant/9003", title: "Deadbolt, Satin Nickel", price: "64.00", unitCost: "41.00" },
  { variantId: "gid://shopify/ProductVariant/9004", title: "Drywall Screws 5lb", price: "21.00", unitCost: "18.50" }, // thin margin: floor demo
  { variantId: "gid://shopify/ProductVariant/9005", title: "LED Panel 2x4", price: "89.00", unitCost: "52.00" },
  { variantId: "gid://shopify/ProductVariant/9006", title: "Cabinet Pull (10pk)", price: "32.00", unitCost: null },
] as const;
const [DOOR, HINGE, LOCK, SCREWS, PANEL, PULL] = VARIANTS.map((v) => v.variantId) as [string, string, string, string, string, string];

export function seedShopify(): FakeShopify {
  const s = new FakeShopify();
  for (const b of Object.values(SEED_BUYERS)) {
    s.addBuyer({ customerId: b.customerId, name: b.name, email: b.email, companyId: b.companyId, companyName: b.companyName, companyLocationId: b.locationId, locations: [{ id: b.locationId, name: "Main" }] });
  }
  for (const v of VARIANTS) s.addVariant({ variantId: v.variantId, title: v.title, price: v.price, unitCost: v.unitCost });
  return s;
}

export interface SeedResult {
  quotes: { id: string; number: number; status: string }[];
}

export async function seed(prisma: PrismaClient, config: Config, opts: { reset?: boolean } = {}): Promise<SeedResult> {
  if (config.nodeEnv === "production") throw new Error("Refusing to seed a production database");
  if (opts.reset) {
    await prisma.$executeRawUnsafe(
      `TRUNCATE "Event","Message","QuoteLine","QuoteVersion","Quote","Job","NotificationPref","CustomerProfile","ActiveQuote","Counter","WebhookReceipt","Staff","Team","TeamMember","ShopSetting","RoutingRule","SavedReply","NotificationLog","SmsOptOut" RESTART IDENTITY CASCADE`,
    );
  } else if ((await prisma.quote.count()) > 0) {
    throw new Error("Database already has quotes; re-run with --reset to wipe and reseed");
  }

  const DAY = 24 * 3600 * 1000;
  const real = Date.now();
  const clock = { now: new Date(real - 40 * DAY) };
  const shopify = seedShopify();
  const app = await buildApp({ config, prisma, shopify, attachments: new FakeAttachmentSigner(), now: () => new Date(clock.now) });
  await app.ready();

  const token = (sub: string) => {
    const t = Math.floor(clock.now.getTime() / 1000);
    return signSessionToken({ iss: `https://${config.shopDomain}/admin`, dest: `https://${config.shopDomain}`, aud: config.apiKey, sub, exp: t + 300 }, config.apiSecret);
  };
  const call = (as: string) => async (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown) => {
    const r = await app.inject({ method, url, headers: { authorization: `Bearer ${token(as)}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, payload: body !== undefined ? JSON.stringify(body) : undefined });
    const parsed = r.body ? JSON.parse(r.body) : undefined;
    if (r.statusCode >= 300) throw new Error(`seed ${method} ${url} -> ${r.statusCode} ${r.body}`);
    return parsed;
  };
  const acme = call(SEED_BUYERS.acme.customerId);
  const acme2 = call(SEED_BUYERS.acme2.customerId);
  const summit = call(SEED_BUYERS.summit.customerId);
  const lakeside = call(SEED_BUYERS.lakeside.customerId);

  // Staff: auto-provisioned on first call, then given names / roles.
  const riley = call("9501");
  const sam = call("9502");
  const morgan = call("9503");
  for (const who of [riley, sam, morgan]) await who("GET", "/s/reports/summary");
  const setStaff = (id: string, data: { name: string; email: string; role?: "rep" | "manager" | "admin"; priceFloorPct?: number }) =>
    prisma.staff.update({ where: { shop_shopifyStaffId: { shop: config.shopDomain, shopifyStaffId: id } }, data });
  await setStaff("9501", { name: "Riley Rep", email: "riley@dsg.example.test", role: "rep" });
  await setStaff("9502", { name: "Sam Sales", email: "sam.sales@dsg.example.test", role: "rep", priceFloorPct: 12 });
  await setStaff("9503", { name: "Morgan Manager", email: "morgan@dsg.example.test", role: "manager", priceFloorPct: 5 });

  const out: SeedResult["quotes"] = [];
  const track = (q: { id: string; number: number; status: string }) => out.push({ id: q.id, number: q.number, status: q.status });
  const addLines = async (as: ReturnType<typeof call>, id: string, lines: [string, number][]) => {
    for (const [variantId, qty] of lines) await as("POST", `/c/quotes/${id}/lines`, { variantId, qty });
  };
  const newQuote = async (as: ReturnType<typeof call>, title: string, job: string, po: string, lines: [string, number][]) => {
    const q = await as("POST", "/c/quotes", { title, newJob: { name: job, poNumber: po, siteAddress: "123 Example St" } });
    await addLines(as, q.id, lines);
    return q.id as string;
  };
  const reprice = async (who: ReturnType<typeof call>, id: string, prices: Record<string, string>, extra: object = {}) => {
    const view = await who("GET", `/s/quotes/${id}`);
    await who("PUT", `/s/quotes/${id}/draft-revision`, {
      lines: view.workingLines.map((l: any) => ({ id: l.id, variantId: l.variantId, qty: l.qty, quotedPrice: prices[l.variantId] ?? l.quotedPrice })),
      ...extra,
    });
  };
  const advance = (days: number) => (clock.now = new Date(clock.now.getTime() + days * DAY));

  // --- EXPIRED (chronologically first): sent 30 days ago, never answered, expired on the first touch after day 14.
  const expiredId = await newQuote(summit, "Old porch rail order", "Maple St porch", "PO-OLD-1", [[PANEL, 6]]);
  await summit("POST", `/c/quotes/${expiredId}/submit`, {});
  await riley("POST", `/s/quotes/${expiredId}/claim`);
  await riley("POST", `/s/quotes/${expiredId}/send`);
  advance(16);
  await expect409(summit, `/c/quotes/${expiredId}/accept`);
  track(await summit("GET", `/c/quotes/${expiredId}`));

  // --- DECLINED
  advance(1);
  const declinedId = await newQuote(lakeside, "Cabinet hardware refresh", "Harbor cafe", "PO-DECL-2", [[PULL, 20], [HINGE, 10]]);
  await lakeside("POST", `/c/quotes/${declinedId}/submit`, {});
  await sam("POST", `/s/quotes/${declinedId}/claim`);
  await morgan("POST", `/s/quotes/${declinedId}/approve-floor`, {}); // the cabinet pull has no cost on file: a manager approves it
  await sam("POST", `/s/quotes/${declinedId}/send`);
  await lakeside("POST", `/c/quotes/${declinedId}/decline`, { reason: "Found a closeout price elsewhere" });
  track(await lakeside("GET", `/c/quotes/${declinedId}`));

  // --- ARCHIVED (customer deleted a draft)
  advance(1);
  const archivedId = await newQuote(acme, "Duplicate draft (deleted)", "Elm St remodel", "PO-DEL-3", [[HINGE, 4]]);
  await acme("DELETE", `/c/quotes/${archivedId}`);
  track({ ...(await prisma.quote.findUniqueOrThrow({ where: { id: archivedId } })) });

  // From here on the clock is "recent".
  clock.now = new Date(real - 6 * DAY);

  // --- DRAFT (Acme)
  const draftId = await newQuote(acme, "Spring door order", "Elm St remodel", "PO-ELM-10", [[DOOR, 8], [HINGE, 16]]);
  track(await acme("GET", `/c/quotes/${draftId}`));

  // --- SUBMITTED (Summit), untouched by sales
  advance(1);
  const submittedId = await newQuote(summit, "Window hardware", "Pine Ridge phase 2", "PO-PR-20", [[LOCK, 12], [HINGE, 24]]);
  await summit("POST", `/c/quotes/${submittedId}/submit`, { notesToSales: "Need delivery by the 15th" });
  track(await summit("GET", `/c/quotes/${submittedId}`));

  // --- SUBMITTED with a below-floor candidate (floor demo for screen 7)
  const floorId = await newQuote(lakeside, "Contractor screws bulk", "Shop buildout", "PO-SB-21", [[SCREWS, 50], [PANEL, 4]]);
  await lakeside("POST", `/c/quotes/${floorId}/submit`, {});
  track(await lakeside("GET", `/c/quotes/${floorId}`));

  // --- IN_REVIEW (Lakeside) with a conversation including an internal note
  advance(1);
  const reviewId = await newQuote(lakeside, "Lighting package", "Harbor cafe", "PO-HC-22", [[PANEL, 18]]);
  await lakeside("POST", `/c/quotes/${reviewId}/submit`, {});
  await riley("POST", `/s/quotes/${reviewId}/claim`);
  await riley("POST", `/s/quotes/${reviewId}/messages`, { body: "Checking stock on the panels, back to you shortly." });
  await riley("POST", `/s/quotes/${reviewId}/messages`, { body: "Internal: supplier quoted 49.00, we can go lower if they take 24.", internal: true });
  await lakeside("POST", `/c/quotes/${reviewId}/messages`, { body: "Thanks, we need these by month end." });
  track(await lakeside("GET", `/c/quotes/${reviewId}`));

  // --- QUOTE_READY v1 (Acme)
  advance(1);
  const readyId = await newQuote(acme, "Deadbolt upgrade", "Elm St remodel", "PO-ELM-11", [[LOCK, 30]]);
  await acme("POST", `/c/quotes/${readyId}/submit`, {});
  await riley("POST", `/s/quotes/${readyId}/claim`);
  await reprice(riley, readyId, { [LOCK]: "58.50" }, { freight: "45.00", repNote: "Price holds for 14 days. Freight to jobsite included." });
  await riley("POST", `/s/quotes/${readyId}/send`);
  track(await acme2("GET", `/c/quotes/${readyId}`)); // a colleague sees the same quote

  // --- QUOTE_READY v2 (Summit): changes requested then re-sent
  advance(1);
  const v2Id = await newQuote(summit, "Entry doors", "Pine Ridge phase 2", "PO-PR-23", [[DOOR, 6]]);
  await summit("POST", `/c/quotes/${v2Id}/submit`, {});
  await sam("POST", `/s/quotes/${v2Id}/claim`);
  await sam("POST", `/s/quotes/${v2Id}/send`);
  await summit("POST", `/c/quotes/${v2Id}/request-changes`, { message: "Can you do better on the doors if we take 12?" });
  await reprice(sam, v2Id, { [DOOR]: "225.00" }, { repNote: "Revised for volume." });
  await sam("POST", `/s/quotes/${v2Id}/send`);
  track(await summit("GET", `/c/quotes/${v2Id}`));

  // --- CHANGES_REQUESTED (Lakeside)
  advance(1);
  const changesId = await newQuote(lakeside, "Pulls and hinges", "Harbor cafe", "PO-HC-24", [[PULL, 40], [HINGE, 40]]);
  await lakeside("POST", `/c/quotes/${changesId}/submit`, {});
  await sam("POST", `/s/quotes/${changesId}/claim`);
  await morgan("POST", `/s/quotes/${changesId}/approve-floor`, {});
  await sam("POST", `/s/quotes/${changesId}/send`);
  await lakeside("POST", `/c/quotes/${changesId}/request-changes`, { message: "Please add 10 more pulls and split the shipment." });
  track(await lakeside("GET", `/c/quotes/${changesId}`));

  // --- ACCEPTED (Acme)
  advance(0.5);
  const acceptedId = await newQuote(acme, "Hinge restock", "Oak Ave duplex", "PO-OA-25", [[HINGE, 200]]);
  await acme("POST", `/c/quotes/${acceptedId}/submit`, {});
  await riley("POST", `/s/quotes/${acceptedId}/claim`);
  await riley("POST", `/s/quotes/${acceptedId}/send`);
  await acme("POST", `/c/quotes/${acceptedId}/accept`, { versionNo: 1 });
  track(await acme("GET", `/c/quotes/${acceptedId}`));

  // --- ORDERED (Summit): accept -> checkout -> orders/create webhook
  advance(0.5);
  const orderedId = await newQuote(summit, "Panel lights", "Pine Ridge phase 1", "PO-PR-26", [[PANEL, 10]]);
  await summit("POST", `/c/quotes/${orderedId}/submit`, {});
  await riley("POST", `/s/quotes/${orderedId}/claim`);
  await reprice(riley, orderedId, { [PANEL]: "79.00" });
  await riley("POST", `/s/quotes/${orderedId}/send`);
  await summit("POST", `/c/quotes/${orderedId}/accept`, { versionNo: 1 });
  await summit("POST", `/c/quotes/${orderedId}/checkout`);
  const ordered = await prisma.quote.findUniqueOrThrow({ where: { id: orderedId } });
  const raw = JSON.stringify({ id: 5001, admin_graphql_api_id: "gid://shopify/Order/5001", tags: `quote:Q-${ordered.number}`, source_name: "shopify_draft_order" });
  const hook = await app.inject({
    method: "POST",
    url: "/webhooks/shopify",
    headers: { "content-type": "application/json", "x-shopify-topic": "orders/create", "x-shopify-shop-domain": config.shopDomain, "x-shopify-webhook-id": "seed-order-5001", "x-shopify-hmac-sha256": signShopifyWebhook(raw, config.apiSecret) },
    payload: raw,
  });
  if (hook.statusCode !== 200) throw new Error("seed webhook failed " + hook.body);
  track(await summit("GET", `/c/quotes/${orderedId}`));

  await app.close();
  return { quotes: out };
}

async function expect409(as: (m: "POST", u: string, b?: unknown) => Promise<unknown>, url: string) {
  try {
    await as("POST", url, {});
  } catch (e) {
    if (String(e).includes("-> 409")) return;
    throw e;
  }
  throw new Error("expected the expiry attempt to be refused with 409");
}

// CLI entry
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = { SHOP_DOMAIN: "dsg-dev.myshopify.com", SHOPIFY_API_KEY: "dev-client-id", SHOPIFY_API_SECRET: "dev-secret-not-for-production", ...process.env };
  const config = loadConfig(env);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const prisma = createPrisma(url);
  seed(prisma, config, { reset: process.argv.includes("--reset") })
    .then((r) => {
      const byStatus = r.quotes.reduce<Record<string, number>>((m, q) => ((m[q.status] = (m[q.status] ?? 0) + 1), m), {});
      console.log(`Seeded ${r.quotes.length} quotes`, byStatus);
    })
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
