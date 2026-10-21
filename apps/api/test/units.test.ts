import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { buildSchema, parse } from "graphql";
import { describe, expect, it } from "vitest";
import { FakeAttachmentSigner, S3AttachmentSigner, presignPut } from "../src/attachments";
import { loadConfig } from "../src/config";
import { DEFAULT_FLOOR_PCT, isBelowFloor } from "../src/domain/lines";
import { D, computeTotals, fmt, marginPctOf, parseMoney } from "../src/domain/money";
import { DOCUMENTS } from "../src/shopify/graphql";
import { RealShopify } from "../src/shopify/real";
import { ShopifyUserError } from "../src/shopify/types";
import { loadSchema, validateDocuments } from "../src/shopify/validate";

describe("money", () => {
  it("formats to 2 places, half-up, from decimals/strings/numbers", () => {
    expect(fmt(D("1234.5"))).toBe("1234.50");
    expect(fmt("0.005")).toBe("0.01");
    expect(fmt(null)).toBe("0.00");
    expect(fmt(D("19.994"))).toBe("19.99");
  });

  it("parses API money strings and rejects garbage", () => {
    expect(parseMoney("12").toString()).toBe("12");
    expect(parseMoney("12.5").toString()).toBe("12.5");
    for (const bad of ["abc", "1.234", "", "1,000.00", "$5"]) expect(() => parseMoney(bad)).toThrow();
  });

  it("totals: subtotal after discount, informational discount, freight, margin only when every cost is known", () => {
    const t = computeTotals(
      [
        { qty: 2, listPrice: D("50"), quotedPrice: D("45"), cost: D("20") },
        { qty: 1, listPrice: D("10"), quotedPrice: D("10"), cost: D("4") },
      ],
      D("12.50"),
    );
    expect(fmt(t.subtotal)).toBe("100.00");
    expect(fmt(t.discountTotal)).toBe("10.00");
    expect(fmt(t.total)).toBe("112.50");
    expect(fmt(t.marginTotal)).toBe("56.00");
    expect(t.marginPct).toBe(56);
    const partial = computeTotals([{ qty: 1, listPrice: D("10"), quotedPrice: D("12"), cost: null }]);
    expect(partial.marginTotal).toBeNull();
    expect(fmt(partial.discountTotal)).toBe("0.00"); // quoting above list is not a "discount"
    expect(computeTotals([]).marginPct).toBeNull();
  });

  it("line margin", () => {
    expect(marginPctOf(D("50"), D("20"))).toBe(60);
    expect(marginPctOf(D("0"), D("20"))).toBeNull();
    expect(marginPctOf(D("50"), null)).toBeNull();
  });
});

describe("price floor rule", () => {
  const line = (q: string, c: string | null) => ({ quotedPrice: D(q), cost: c == null ? null : D(c) });
  it("is strictly below the floor margin; exactly on the floor passes; unknown cost passes", () => {
    expect(DEFAULT_FLOOR_PCT).toBe(15);
    expect(isBelowFloor(line("100", "85"), 15)).toBe(false); // exactly 15%
    expect(isBelowFloor(line("100", "85.01"), 15)).toBe(true);
    expect(isBelowFloor(line("100", "90"), 15)).toBe(true);
    expect(isBelowFloor(line("100", null), 15)).toBe(false);
    expect(isBelowFloor(line("0", "5"), 15)).toBe(true); // giving it away
    expect(isBelowFloor(line("10", "20"), 0)).toBe(true); // selling under cost fails even a 0% floor
    expect(isBelowFloor(line("20", "20"), 0)).toBe(false);
  });
});

describe("attachments", () => {
  const now = new Date("2013-05-24T00:00:00Z");
  const cfg = { bucket: "bkt", endpoint: "https://s3.example.test", region: "us-east-1", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", publicBaseUrl: "https://files.example.test" };

  it("presignPut is deterministic and well-formed (SigV4 query auth, path style)", () => {
    const args = { endpoint: cfg.endpoint, bucket: cfg.bucket, key: "quotes/q1/a b.pdf", region: cfg.region, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, expiresSeconds: 900, now };
    const a = presignPut(args);
    expect(a).toBe(presignPut(args));
    const u = new URL(a);
    expect(u.host).toBe("s3.example.test");
    expect(u.pathname).toBe("/bkt/quotes/q1/a%20b.pdf");
    expect(u.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(u.searchParams.get("X-Amz-Credential")).toBe("AKIDEXAMPLE/20130524/us-east-1/s3/aws4_request");
    expect(u.searchParams.get("X-Amz-Date")).toBe("20130524T000000Z");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(presignPut({ ...args, secretAccessKey: "other" })).not.toBe(a);
  });

  it("signers only accept their own file URLs", () => {
    const s3 = new S3AttachmentSigner(cfg);
    const up = s3.createUpload({ quoteId: "q1", name: "../../etc/passwd", mime: "text/plain", size: 5, now });
    expect(up.fileUrl.startsWith("https://files.example.test/quotes/q1/")).toBe(true);
    expect(up.fileUrl).not.toContain("..");
    expect(up.expiresAt.getTime()).toBe(now.getTime() + 15 * 60_000);
    expect(s3.isOwnUrl(up.fileUrl)).toBe(true);
    expect(s3.isOwnUrl("https://files.example.test.evil.com/x")).toBe(false);
    expect(s3.isOwnUrl("https://evil.example/quotes/q1/x")).toBe(false);
    expect(new FakeAttachmentSigner().isOwnUrl("https://evil.example/x")).toBe(false);
  });
});

describe("config", () => {
  const base = { SHOP_DOMAIN: "s.myshopify.com", SHOPIFY_API_KEY: "k", SHOPIFY_API_SECRET: "x" };
  it("requires the Shopify identifiers and applies defaults", () => {
    expect(() => loadConfig({})).toThrow(/SHOP_DOMAIN/);
    const c = loadConfig(base);
    expect(c).toMatchObject({ shopDomain: "s.myshopify.com", defaultExpiryDays: 14, signatureMaxAgeSeconds: 300, attachments: null, port: 3000 });
  });
  it("enables attachments only when a bucket is configured, and then needs credentials", () => {
    expect(() => loadConfig({ ...base, ATTACHMENTS_BUCKET: "b", ATTACHMENTS_S3_ENDPOINT: "https://s3.test" })).toThrow(/ATTACHMENTS_ACCESS_KEY_ID/);
    const c = loadConfig({ ...base, ATTACHMENTS_BUCKET: "b", ATTACHMENTS_S3_ENDPOINT: "https://s3.test", ATTACHMENTS_ACCESS_KEY_ID: "a", ATTACHMENTS_SECRET_ACCESS_KEY: "s" });
    expect(c.attachments).toMatchObject({ bucket: "b", publicBaseUrl: "https://s3.test/b" });
  });
});

describe("graphql:validate", () => {
  const sdl = `
    type Query { shop: Shop customer(id: ID!): Customer productVariant(id: ID!): ProductVariant }
    type Shop { currencyCode: String! }
    type Customer { id: ID! }
    type ProductVariant { id: ID! }
    type Mutation { ping: Boolean }
  `;

  it("flags documents that reference fields missing from the schema, passes valid ones", () => {
    const schema = buildSchema(sdl);
    const failures = validateDocuments(schema, {
      good: "query G { shop { currencyCode } }",
      badField: "query B { shop { nope } }",
      badSyntax: "query { shop { ",
    });
    expect(failures.map((f) => f.name).sort()).toEqual(["badField", "badSyntax"]);
    expect(failures.find((f) => f.name === "badField")!.errors[0]).toContain('Cannot query field "nope"');
  });

  it("loads SDL and both introspection JSON shapes", async () => {
    const { introspectionFromSchema } = await import("graphql");
    const intro = introspectionFromSchema(buildSchema(sdl));
    for (const text of [sdl, JSON.stringify({ data: intro }), JSON.stringify(intro)]) {
      expect(() => loadSchema(text).getQueryType()).not.toThrow();
    }
  });

  it("every shipped document is syntactically valid GraphQL and named", () => {
    expect(Object.keys(DOCUMENTS).length).toBeGreaterThanOrEqual(5);
    for (const [name, doc] of Object.entries(DOCUMENTS)) {
      expect(() => parse(doc), name).not.toThrow();
      expect(doc).toMatch(/\b(query|mutation)\s+\w+/);
    }
  });

  it("the script fails loudly (exit 2) when no schema file is configured, and exits 1 on an invalid document", () => {
    const run = (env: Record<string, string>) =>
      spawnSync(process.execPath, [join(__dirname, "..", "node_modules", "tsx", "dist", "cli.mjs"), join(__dirname, "..", "scripts", "graphql-validate.ts")], {
        env: { PATH: process.env.PATH ?? "", ...env },
        encoding: "utf8",
        cwd: join(__dirname, ".."),
      });
    const none = run({});
    expect(none.status).toBe(2);
    expect(none.stderr).toContain("SHOPIFY_SCHEMA_PATH");
    const missing = run({ SHOPIFY_SCHEMA_PATH: "/nonexistent/schema.graphql" });
    expect(missing.status).toBe(2);
  });
});

describe("RealShopify (request shaping against a stub fetch; NOT verified against live Shopify)", () => {
  function stub(responses: unknown[]) {
    const calls: { url: string; headers: Record<string, string>; body: { query: string; variables: any } }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
      return { ok: true, status: 200, json: async () => ({ data: responses.shift() }) } as Response;
    }) as unknown as typeof fetch;
    return { calls, shop: new RealShopify({ shopDomain: "s.myshopify.com", getAccessToken: async () => "tok", fetchImpl }) };
  }

  it("resolveBuyer maps the contact, selects among permitted locations and reads net terms", async () => {
    const { shop, calls } = stub([
      {
        shop: { currencyCode: "USD" },
        customer: {
          id: "gid://shopify/Customer/1",
          displayName: "Dana",
          defaultEmailAddress: { emailAddress: "d@example.test" },
          companyContactProfiles: [
            {
              id: "gid://shopify/CompanyContact/5",
              company: { id: "gid://shopify/Company/2", name: "Acme" },
              roleAssignments: {
                nodes: [
                  { companyLocation: { id: "L1", name: "Main", buyerExperienceConfiguration: null } },
                  { companyLocation: { id: "L2", name: "Branch", buyerExperienceConfiguration: { paymentTermsTemplate: { id: "PT1" } } } },
                ],
              },
            },
          ],
        },
      },
    ]);
    const b = await shop.resolveBuyer("gid://shopify/Customer/1", "L2");
    expect(b).toMatchObject({ companyId: "gid://shopify/Company/2", companyContactId: "gid://shopify/CompanyContact/5", companyLocationId: "L2", paymentTermsTemplateId: "PT1", currencyCode: "USD", email: "d@example.test" });
    expect(b!.locations.map((l) => l.id)).toEqual(["L1", "L2"]);
    expect(calls[0]!.url).toBe("https://s.myshopify.com/admin/api/2026-07/graphql.json");
    expect(calls[0]!.headers["x-shopify-access-token"]).toBe("tok");
    const none = await stub([{ shop: { currencyCode: "USD" }, customer: { id: "x", displayName: "x", defaultEmailAddress: null, companyContactProfiles: [] } }]).shop.resolveBuyer("x");
    expect(none).toBeNull();
  });

  it("getVariantPricing uses contextual pricing for the company location and formats money", async () => {
    const { shop, calls } = stub([
      { productVariant: { id: "V", sku: "S", displayName: "Door - 32in", image: null, product: { featuredMedia: { preview: { image: { url: "https://img/x.png" } } } }, contextualPricing: { price: { amount: "41.5" } }, inventoryItem: { unitCost: { amount: "20" } } } },
    ]);
    const p = await shop.getVariantPricing({ companyLocationId: "L1" }, "V");
    expect(p).toEqual({ variantId: "V", sku: "S", title: "Door - 32in", imageUrl: "https://img/x.png", price: "41.50", unitCost: "20.00" });
    expect(calls[0]!.body.variables).toEqual({ id: "V", companyLocationId: "L1" });
    expect(await stub([{ productVariant: null }]).shop.getVariantPricing({ companyLocationId: "L1" }, "V")).toBeNull();
  });

  it("createDraftOrder sends purchasingCompany, priceOverride, freight shipping line, tag and PO; userErrors become ShopifyUserError", async () => {
    const { shop, calls } = stub([{ draftOrderCreate: { draftOrder: { id: "gid://shopify/DraftOrder/1", name: "#D1", invoiceUrl: "https://inv" }, userErrors: [] } }]);
    const out = await shop.createDraftOrder({
      quoteLabel: "Q-10001", currencyCode: "USD", customerId: "C", companyId: "CO", companyContactId: "CC", companyLocationId: "CL",
      lines: [{ variantId: "V", quantity: 3, priceOverride: "41.25" }], freight: "30.00", poNumber: "PO-1", note: "n", tags: ["quote:Q-10001"], paymentTermsTemplateId: "PT",
    });
    expect(out).toEqual({ id: "gid://shopify/DraftOrder/1", name: "#D1", invoiceUrl: "https://inv" });
    const input = calls[0]!.body.variables.input;
    expect(input.purchasingEntity).toEqual({ purchasingCompany: { companyId: "CO", companyContactId: "CC", companyLocationId: "CL" } });
    expect(input.lineItems).toEqual([{ variantId: "V", quantity: 3, priceOverride: { amount: "41.25", currencyCode: "USD" } }]);
    expect(input).toMatchObject({ tags: ["quote:Q-10001"], poNumber: "PO-1", shippingLine: { title: "Freight", price: "30.00" }, paymentTerms: { paymentTermsTemplateId: "PT" } });

    const failing = stub([{ draftOrderCreate: { draftOrder: null, userErrors: [{ field: ["lineItems"], message: "Variant is out of stock" }] } }]).shop;
    await expect(failing.createDraftOrder({ quoteLabel: "Q", currencyCode: "USD", customerId: "C", companyId: "CO", companyContactId: "CC", companyLocationId: "CL", lines: [], freight: null, poNumber: null, note: null, tags: [], paymentTermsTemplateId: null })).rejects.toBeInstanceOf(ShopifyUserError);
  });

  it("complete and delete draft orders; delete never throws", async () => {
    const { shop } = stub([{ draftOrderComplete: { draftOrder: { id: "D", order: { id: "O", statusPageUrl: "https://status" } }, userErrors: [] } }]);
    expect(await shop.completeDraftOrder("D", { paymentPending: true })).toEqual({ draftOrderId: "D", orderId: "O", statusUrl: "https://status" });
    const boom = new RealShopify({ shopDomain: "s", getAccessToken: async () => "t", fetchImpl: (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch });
    await expect(boom.deleteDraftOrder("D")).resolves.toBeUndefined();
    await expect(boom.resolveBuyer("C")).rejects.toThrow(/HTTP 500/);
  });
});

describe("Prisma decimal sanity", () => {
  it("Decimal arithmetic is exact (no float drift in totals)", () => {
    expect(new Prisma.Decimal("0.1").add("0.2").toString()).toBe("0.3");
    expect(fmt(computeTotals([{ qty: 3, listPrice: D("0.1"), quotedPrice: D("0.1"), cost: null }]).total)).toBe("0.30");
  });
});
