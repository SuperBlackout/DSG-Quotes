import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { FakeAttachmentSigner } from "../src/attachments";
import { createPrisma } from "../src/db";
import { FakeShopify } from "../src/shopify/fake";
import { HITS_FILE } from "./global-setup";
import { contractOperations, contractPath } from "./openapi";
import { testConfig } from "./helpers";

/**
 * "Every endpoint has a test": every registered route must have been exercised successfully (2xx) by the
 * integration tests that ran before this file (files run alphabetically; this one is last). Also checks the
 * implementation against docs/openapi.yaml in both directions.
 * Run the whole suite (`pnpm -F api test`) for this to be meaningful; it fails on a partial run by design.
 */
describe("endpoint coverage", () => {
  it("every registered route has at least one passing test, and the API matches the contract", async () => {
    const prisma = createPrisma(process.env.TEST_DATABASE_URL!);
    const registered = new Set<string>();
    const app = await buildApp(
      { config: testConfig(), prisma, shopify: new FakeShopify(), attachments: new FakeAttachmentSigner(), now: () => new Date() },
      { onRoute: (m, url) => m !== "HEAD" && m !== "OPTIONS" && registered.add(`${m} ${url}`) },
    );
    await app.ready();
    await app.close();
    await prisma.$disconnect();

    // Canonical route = strip the alternate mount prefixes (/proxy/c -> /c, /api/s -> /s).
    const canon = (key: string) => {
      const [m, url] = key.split(" ") as [string, string];
      return `${m} ${contractPath(url)}`;
    };
    const routes = new Set([...registered].map(canon));

    expect(existsSync(HITS_FILE), "no route hits recorded: run the full suite").toBe(true);
    const hits = readFileSync(HITS_FILE, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { method: string; url: string; status: number });
    const ok = new Set(hits.filter((h) => h.status < 400).map((h) => canon(`${h.method} ${h.url}`)));
    const failed = new Set(hits.filter((h) => h.status >= 400).map((h) => canon(`${h.method} ${h.url}`)));

    const untested = [...routes].filter((r) => !ok.has(r)).sort();
    expect(untested, "routes with no successful test").toEqual([]);

    // Customer and staff routes also need an error-path test somewhere (auth, validation, scoping, transitions).
    const noErrorPath = [...routes].filter((r) => /^\w+ \/(c|s)\//.test(r) && !failed.has(r)).sort();
    expect(noErrorPath, "routes with no failing-request test").toEqual([]);

    // Contract <-> implementation.
    const contract = contractOperations().filter((o) => /^\/(c|s)\//.test(o.path)).map((o) => `${o.method} ${o.path}`);
    const missingFromApi = contract.filter((c) => !routes.has(c)).sort();
    expect(missingFromApi, "operations in docs/openapi.yaml that the API does not implement").toEqual([]);
    const notInContract = [...routes].filter((r) => /^\w+ \/(c|s)\//.test(r) && !contract.includes(r)).sort();
    expect(notInContract, "API routes missing from docs/openapi.yaml").toEqual([]);

    // Sanity: we really enumerated the surface.
    expect(routes.size).toBeGreaterThanOrEqual(38);
    expect(routes.has("GET /healthz")).toBe(true);
    expect(routes.has("POST /webhooks/shopify")).toBe(true);
  });
});
