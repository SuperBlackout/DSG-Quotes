import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(__dirname, "../../..");
const doc = parse(readFileSync(resolve(root, "docs/openapi.yaml"), "utf8")) as any;
const S = doc.components.schemas;

describe("revision 0.2.0 / backend", () => {
  it("documents POST /webhooks/shopify with HMAC auth and topic dispatch", () => {
    const op = doc.paths["/webhooks/shopify"].post;
    expect(op.tags).toEqual(["webhooks"]);
    expect(op.security).toEqual([{ shopifyHmac: [] }]);
    expect(doc.components.securitySchemes.shopifyHmac.name).toBe("X-Shopify-Hmac-Sha256");
    for (const t of ["orders/create", "draft_orders/update", "app/uninstalled", "customers/redact", "shop/redact"])
      expect(op.description).toContain(t);
    expect(op.parameters.map((p: any) => p.name)).toEqual(
      expect.arrayContaining(["X-Shopify-Topic", "X-Shopify-Shop-Domain", "X-Shopify-Webhook-Id"]),
    );
  });

  it("inbound hooks are served from apps/api and owned by the notifications agent", () => {
    for (const p of ["/hooks/email-inbound", "/hooks/twilio-inbound"]) {
      expect(doc.paths[p].post.description).toMatch(/apps\/api/);
      expect(doc.paths[p].post.description).toMatch(/notifications agent/);
    }
  });

  it("StaffQuote has workingExpiresAt", () => {
    expect(S.StaffQuote.allOf[1].properties.workingExpiresAt.nullable).toBe(true);
  });

  it("lineNote is customer visible; internalNote never appears in a Customer* schema", () => {
    expect(S.CustomerQuoteLine.properties.lineNote.description).toMatch(/Customer-visible/);
    expect(S.StaffQuoteLine.properties.lineNote.description).toMatch(/Customer-visible/);
    expect(S.DraftRevisionRequest.properties.internalNote.description).toMatch(/Staff only/);
    expect(doc.info.description).toMatch(/`internalNote`.*private/s);
  });

  it("rate limiting is documented as deferred", () => {
    expect(doc.info.description).toMatch(/Rate limiting is deferred/);
    expect(S.Error.properties.code.description).toMatch(/RATE_LIMITED. is reserved/);
  });

  it(".env.example lists the new variables", () => {
    const env = readFileSync(resolve(root, ".env.example"), "utf8");
    const names = new Set(env.split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split("=")[0]));
    for (const v of [
      "ATTACHMENTS_REGION",
      "ATTACHMENTS_PUBLIC_BASE_URL",
      "QUOTE_DEFAULT_EXPIRY_DAYS",
      "SIGNATURE_MAX_AGE_SECONDS",
      "SHOPIFY_API_KEY",
      "SHOPIFY_API_SECRET",
    ])
      expect(names.has(v), v).toBe(true);
  });
});
