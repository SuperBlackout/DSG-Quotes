import { appendFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { buildApp } from "../../../../apps/api/src/app";
import { FakeAttachmentSigner } from "../../../../apps/api/src/attachments";
import { signAppProxyQuery, signSessionToken, signShopifyWebhook } from "../../../../apps/api/src/auth/crypto";
import type { Config } from "../../../../apps/api/src/config";
import type { AppDeps } from "../../../../apps/api/src/context";
import { createPrisma } from "../../../../apps/api/src/db";
import { applyTransition, lockQuote } from "../../../../apps/api/src/domain/transitions";
import { FakeShopify } from "../../../../apps/api/src/shopify/fake";
import { contractPath, findOperation, validateRequestBody, validateResponse } from "./contract";
import { E2E_DB_URL, HITS_FILE, assertDisposableDb } from "./env";
import * as F from "./fixtures";
import { findLeaks } from "./leak";

// ------------------------------------------------------------------ types

export interface Res {
  status: number;
  body: any;
  text: string;
  headers: Record<string, any>;
  /** Fastify route pattern that served the request (x-route-pattern, test builds only). */
  route: string;
}

export interface CallOpts {
  /** Skip the "request body satisfies the contract" check (for deliberately invalid requests). */
  loose?: boolean;
  headers?: Record<string, string>;
}

export interface Actor {
  label: string;
  get(url: string, o?: CallOpts): Promise<Res>;
  post(url: string, body?: unknown, o?: CallOpts): Promise<Res>;
  put(url: string, body?: unknown, o?: CallOpts): Promise<Res>;
  patch(url: string, body?: unknown, o?: CallOpts): Promise<Res>;
  del(url: string, o?: CallOpts): Promise<Res>;
}

export interface StaffRow {
  id: string;
  shopifyId: string;
  name: string;
}

export interface World {
  app: FastifyInstance;
  deps: AppDeps;
  prisma: PrismaClient;
  shopify: FakeShopify;
  clock: { now: Date };
  /** Dealers (customer-account bearer token). */
  dana: Actor; // Acme, Main location
  danaBranch: Actor; // Dana acting for Acme Branch (X-Company-Location-Id)
  drew: Actor; // Acme colleague, Main location
  bea: Actor; // Other Co
  /** Dana through the storefront app proxy (HMAC-signed query) instead of a bearer token. */
  danaProxy: Actor;
  /** Staff (admin session token). */
  rep1: Actor;
  rep2: Actor;
  manager: Actor;
  staff: { rep1: StaffRow; rep2: StaffRow; manager: StaffRow };
  /** No credentials at all. */
  anon: Actor;
  /** Hand-rolled request, no auth, no checks (webhook / negative auth tests). */
  raw(o: { method: string; url: string; headers?: Record<string, string>; payload?: string | Buffer }): Promise<Res>;
  /** Signed Shopify webhook delivery (X-Shopify-Hmac-Sha256 over the raw body). */
  webhook(topic: string, payload: unknown, o?: { id?: string; secret?: string; shop?: string }): Promise<Res>;
  /** Move the app clock; JWTs and expiry checks follow it. */
  setNow(iso: string): void;
  advance(ms: number): void;
  /** Stand-in for the worker's hourly EXPIRE cron (apps/worker is not built yet): expires every due quote. */
  runExpiryCron(): Promise<string[]>;
  /** Wipe every table and re-provision fake Shopify + staff. Called automatically by useWorld. */
  reset(): Promise<void>;
  /** Count of /c responses deep-scanned for leaks so far (proves the scan actually ran). */
  leakScans: { count: number };
}

export const DAY = 24 * 60 * 60 * 1000;
export const START = "2026-03-02T15:00:00.000Z";

// ------------------------------------------------------------------ fake Shopify

export function seedShopify(s: FakeShopify): void {
  s.buyers.clear();
  s.variants.clear();
  s.createdDraftOrders.length = 0;
  s.completedDraftOrders.length = 0;
  s.deletedDraftOrders.length = 0;
  s.failNextCreate = null;
  const mainBranch = [
    { id: F.LOC_ACME_MAIN, name: "Main" },
    { id: F.LOC_ACME_BRANCH, name: "Branch" },
  ];
  s.addBuyer({ customerId: F.DANA.id, name: F.DANA.name, email: "dana@acme.example.test", companyId: F.ACME.id, companyName: F.ACME.name, companyLocationId: F.LOC_ACME_MAIN, locations: mainBranch });
  s.addBuyer({ customerId: F.DREW.id, name: F.DREW.name, email: "drew@acme.example.test", companyId: F.ACME.id, companyName: F.ACME.name, companyLocationId: F.LOC_ACME_MAIN, locations: [mainBranch[0]!] });
  s.addBuyer({ customerId: F.BEA.id, name: F.BEA.name, email: "bea@otherco.example.test", companyId: F.OTHERCO.id, companyName: F.OTHERCO.name, companyLocationId: F.LOC_OTHER_HQ, locations: [{ id: F.LOC_OTHER_HQ, name: "HQ" }] });
  s.addVariant({ variantId: F.V_PIPE, price: F.PRICE.PIPE, unitCost: F.COST.PIPE, title: "Copper Pipe 10ft" });
  s.addVariant({ variantId: F.V_PIPE, price: F.PRICE.PIPE_OTHERCO, unitCost: F.COST.PIPE, title: "Copper Pipe 10ft" }, F.LOC_OTHER_HQ);
  s.addVariant({ variantId: F.V_VALVE, price: F.PRICE.VALVE, unitCost: F.COST.VALVE, title: "Ball Valve 1in" });
  s.addVariant({ variantId: F.V_THIN, price: F.PRICE.THIN, unitCost: F.COST.THIN, title: "Thin-margin Fitting" });
  s.addVariant({ variantId: F.V_NOCOST, price: F.PRICE.NOCOST, unitCost: null, title: "No-cost Gasket" });
}

export function testConfig(): Config {
  return {
    nodeEnv: "test",
    port: 0,
    host: "127.0.0.1",
    shopDomain: F.SHOP,
    apiKey: F.API_KEY,
    apiSecret: F.API_SECRET,
    appPublicUrl: `https://${F.SHOP}/apps/quotes`,
    defaultExpiryDays: 14,
    signatureMaxAgeSeconds: 300,
    attachments: null,
  };
}

function token(sub: string, now: Date, iss: string): string {
  const t = Math.floor(now.getTime() / 1000);
  return signSessionToken({ iss, dest: `https://${F.SHOP}`, aud: F.API_KEY, sub, exp: t + 60, nbf: t - 5, iat: t }, F.API_SECRET);
}
export const customerToken = (id: string, now = new Date()) => token(id, now, "https://shopify.com/123");
export const staffToken = (id: string, now = new Date()) => token(id, now, `https://${F.SHOP}/admin`);

// ------------------------------------------------------------------ the world

export interface UseWorldOptions {
  /** "test" (default): wipe before every test. "file": wipe once, tests in the file share state in order. */
  isolate?: "test" | "file";
}

/** Call inside a describe(). Boots the real API (apps/api) on the disposable Postgres with the fake Shopify gateway. */
export function useWorld(opts: UseWorldOptions = {}): World {
  const w = {} as World;
  const clock = { now: new Date(START) };
  const leakScans = { count: 0 };
  let tables: string[] | null = null;

  const send = async (
    o: { method: string; url: string; headers?: Record<string, string>; payload?: string | Buffer },
    meta: { check: boolean; loose?: boolean; sentBody?: unknown } = { check: true },
  ): Promise<Res> => {
    const r = await w.app.inject({ method: o.method as any, url: o.url, headers: o.headers, payload: o.payload as any });
    let body: any;
    try {
      body = r.body ? JSON.parse(r.body) : undefined;
    } catch {
      body = undefined;
    }
    const route = String(r.headers["x-route-pattern"] ?? "");
    const res: Res = { status: r.statusCode, body, text: r.body, headers: r.headers as Record<string, any>, route };
    if (!meta.check) return res;

    const where = `${o.method} ${o.url.split("?")[0]} -> ${r.statusCode}`;
    const isApi = /^\/(proxy\/)?c\//.test(route) || /^\/(api\/)?s\//.test(route);
    if (route && isApi) {
      const op = findOperation(o.method, route);
      if (!op) throw new Error(`CONTRACT: ${where}: route ${route} is served by the API but is not in docs/openapi.yaml`);
      const errs = validateResponse(o.method, route, r.statusCode, body);
      if (errs.length) throw new Error(`CONTRACT: ${where} response violates docs/openapi.yaml:\n  ${errs.slice(0, 10).join("\n  ")}\n  body: ${r.body.slice(0, 600)}`);
      if (r.statusCode < 400 && !meta.loose) {
        const reqErrs = validateRequestBody(o.method, route, meta.sentBody);
        if (reqErrs.length) throw new Error(`CONTRACT: ${where}: the API accepted a request body that violates the contract (test bug or API too lenient):\n  ${reqErrs.join("\n  ")}`);
      }
      appendFileSync(HITS_FILE, JSON.stringify({ method: o.method.toUpperCase(), path: contractPath(route), status: r.statusCode }) + "\n");
    }
    // Privacy: every response on a customer route, success or error, is deep-scanned (CLAUDE.md rules 4 and 5).
    if (/^\/(proxy\/)?c\//.test(route) || /^\/(proxy\/)?c\//.test(o.url)) {
      leakScans.count += 1;
      const leaks = findLeaks(r.body ?? "", body);
      if (leaks.length) throw new Error(`PRIVACY LEAK in ${where}:\n  ${leaks.join("\n  ")}\n  body: ${r.body.slice(0, 800)}`);
    }
    return res;
  };

  const actor = (label: string, headers: () => Record<string, string>, urlFn: (u: string) => string = (u) => u): Actor => {
    const mk =
      (method: string) =>
      (url: string, a?: unknown, b?: unknown): Promise<Res> => {
        const hasBody = method === "POST" || method === "PUT" || method === "PATCH";
        const body = hasBody ? a : undefined;
        const o = (hasBody ? b : a) as CallOpts | undefined;
        return send(
          {
            method,
            url: urlFn(url),
            headers: { ...headers(), ...(o?.headers ?? {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
            payload: body !== undefined ? JSON.stringify(body) : undefined,
          },
          { check: true, loose: o?.loose, sentBody: body },
        );
      };
    return { label, get: mk("GET") as any, post: mk("POST") as any, put: mk("PUT") as any, patch: mk("PATCH") as any, del: mk("DELETE") as any };
  };

  const bearer = (kind: "customer" | "staff", id: string, extra: Record<string, string> = {}) => () => ({
    authorization: `Bearer ${kind === "customer" ? customerToken(id, clock.now) : staffToken(id, clock.now)}`,
    ...extra,
  });

  beforeAll(async () => {
    assertDisposableDb(E2E_DB_URL);
    const prisma = createPrisma(E2E_DB_URL);
    const shopify = new FakeShopify();
    seedShopify(shopify);
    const deps: AppDeps = { config: testConfig(), prisma, shopify, attachments: new FakeAttachmentSigner(), now: () => new Date(clock.now) };
    const app = await buildApp(deps, { exposeRoute: true });
    await app.ready();
    Object.assign(w, { app, deps, prisma, shopify, clock, leakScans });

    w.raw = (o) => send(o, { check: false });
    w.anon = actor("anonymous", () => ({}));
    w.dana = actor("dana", bearer("customer", F.DANA.id));
    w.danaBranch = actor("dana@branch", bearer("customer", F.DANA.id, { "x-company-location-id": F.LOC_ACME_BRANCH }));
    w.drew = actor("drew", bearer("customer", F.DREW.id));
    w.bea = actor("bea", bearer("customer", F.BEA.id));
    w.rep1 = actor("rep1", bearer("staff", F.REP1.shopifyId));
    w.rep2 = actor("rep2", bearer("staff", F.REP2.shopifyId));
    w.manager = actor("manager", bearer("staff", F.MANAGER.shopifyId));
    // App proxy flavour: Shopify forwards /apps/quotes/c/... as /proxy/c/... with a signed query string.
    w.danaProxy = actor(
      "dana-proxy",
      () => ({}),
      (u) => {
        const [path, q = ""] = u.split("?");
        const extra = Object.fromEntries(new URLSearchParams(q));
        const signed = signAppProxyQuery({ shop: F.SHOP, logged_in_customer_id: F.DANA.id.split("/").pop()!, path_prefix: "/apps/quotes", ...extra }, F.API_SECRET, clock.now);
        return `/proxy${path}?${signed}`;
      },
    );

    w.webhook = (topic, payload, o = {}) => {
      const raw = JSON.stringify(payload);
      return send(
        {
          method: "POST",
          url: "/webhooks/shopify",
          headers: {
            "content-type": "application/json",
            "x-shopify-topic": topic,
            "x-shopify-shop-domain": o.shop ?? F.SHOP,
            "x-shopify-webhook-id": o.id ?? `wh-${Math.random().toString(36).slice(2)}`,
            "x-shopify-hmac-sha256": signShopifyWebhook(raw, o.secret ?? F.API_SECRET),
          },
          payload: raw,
        },
        { check: false },
      );
    };

    w.setNow = (iso) => {
      clock.now = new Date(iso);
    };
    w.advance = (ms) => {
      clock.now = new Date(clock.now.getTime() + ms);
    };

    w.runExpiryCron = async () => {
      const due = await prisma.quote.findMany({
        where: { status: { in: ["QUOTE_READY", "ACCEPTED"] }, expiresAt: { lte: clock.now } },
        select: { id: true },
      });
      const done: string[] = [];
      for (const { id } of due) {
        await prisma.$transaction(async (tx) => {
          const q = await lockQuote(tx, id);
          if (!q) return;
          await applyTransition(tx, { quote: q, event: "EXPIRE", actor: "system", actorId: null, now: clock.now, payload: { by: "e2e-cron-standin" } });
          done.push(id);
        });
      }
      return done;
    };

    w.reset = async () => {
      clock.now = new Date(START);
      if (!tables) {
        const rows = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename::text AS tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '\_prisma%'`;
        tables = rows.map((r) => r.tablename);
      }
      await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
      seedShopify(shopify);
      // Provision staff: the API creates a Staff row on a staff member's first call; then we set role and floor.
      const make = async (a: Actor, who: { shopifyId: string; name: string }, patch: { isManager?: boolean }) => {
        const r = await a.get("/s/reports/summary");
        if (r.status !== 200) throw new Error(`could not provision ${who.shopifyId}: ${r.text}`);
        const row = await prisma.staff.update({
          where: { shop_shopifyStaffId: { shop: F.SHOP, shopifyStaffId: who.shopifyId } },
          data: { name: who.name, isManager: !!patch.isManager, priceFloorPct: F.DEFAULT_FLOOR_PCT },
        });
        return { id: row.id, shopifyId: who.shopifyId, name: who.name };
      };
      w.staff = {
        rep1: await make(w.rep1, F.REP1, {}),
        rep2: await make(w.rep2, F.REP2, {}),
        manager: await make(w.manager, F.MANAGER, { isManager: true }),
      };
    };

    await w.reset();
  });

  if ((opts.isolate ?? "test") === "test") {
    let first = true;
    beforeEach(async () => {
      if (first) first = false; // beforeAll already reset
      else await w.reset();
    });
  }

  afterAll(async () => {
    await w.app.close();
    await w.prisma.$disconnect();
  });
  return w;
}
