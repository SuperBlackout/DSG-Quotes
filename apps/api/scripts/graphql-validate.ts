/**
 * `pnpm -F api graphql:validate`
 *
 * Validates every Admin GraphQL document in src/shopify/graphql.ts against a downloaded schema.
 * The schema is NOT committed. Download the Admin GraphQL schema for ADMIN_API_VERSION (introspection JSON
 * or SDL, e.g. from shopify.dev's "Download schema" / the Shopify Dev MCP) and point to it:
 *
 *   SHOPIFY_SCHEMA_PATH=/path/to/admin-2026-07.json pnpm -F api graphql:validate
 *
 * Exits 2 when the schema path is missing (so CI cannot mistake "not run" for "passed").
 */
import { readFileSync } from "node:fs";
import { ADMIN_API_VERSION } from "shared";
import { DOCUMENTS } from "../src/shopify/graphql";
import { loadSchema, validateDocuments } from "../src/shopify/validate";

const path = process.env.SHOPIFY_SCHEMA_PATH;
if (!path) {
  console.error(
    `graphql:validate: SHOPIFY_SCHEMA_PATH is not set.\n` +
      `Download the Admin GraphQL schema for ${ADMIN_API_VERSION} (introspection JSON or SDL) and set SHOPIFY_SCHEMA_PATH.`,
  );
  process.exit(2);
}

let schema;
try {
  schema = loadSchema(readFileSync(path, "utf8"));
} catch (e) {
  console.error(`graphql:validate: could not load schema from ${path}: ${(e as Error).message}`);
  process.exit(2);
}

const failures = validateDocuments(schema, DOCUMENTS);
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f.name}: ${f.errors.join(" | ")}`);
  process.exit(1);
}
console.log(`graphql:validate: ${Object.keys(DOCUMENTS).length} documents valid against ${path} (API ${ADMIN_API_VERSION})`);
