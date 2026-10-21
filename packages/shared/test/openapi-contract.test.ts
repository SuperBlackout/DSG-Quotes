import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const doc = parse(readFileSync(resolve(__dirname, "../../../docs/openapi.yaml"), "utf8")) as any;
const FORBIDDEN = ["cost", "marginPct", "marginTotal", "marginTotal", "internalNote", "workingInternalNote", "internal", "belowFloor", "floorApproved"];

/** Collect every property name reachable from a schema (follows $ref/allOf/oneOf/items). */
function propNames(schema: any, seen = new Set<string>(), out = new Set<string>()): Set<string> {
  if (!schema || typeof schema !== "object") return out;
  if (schema.$ref) {
    const name = String(schema.$ref).split("/").pop()!;
    if (seen.has(name)) return out;
    seen.add(name);
    return propNames(doc.components.schemas[name], seen, out);
  }
  for (const k of Object.keys(schema.properties ?? {})) {
    out.add(k);
    propNames(schema.properties[k], seen, out);
  }
  for (const key of ["allOf", "oneOf", "anyOf"]) for (const s of schema[key] ?? []) propNames(s, seen, out);
  if (schema.items) propNames(schema.items, seen, out);
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") propNames(schema.additionalProperties, seen, out);
  return out;
}

describe("openapi.yaml privacy contract", () => {
  const customerSchemas = Object.keys(doc.components.schemas).filter((n) => /^Customer/.test(n));

  it("has customer schemas", () => expect(customerSchemas.length).toBeGreaterThan(4));

  for (const name of customerSchemas) {
    it(`${name} exposes no cost / margin / internal fields`, () => {
      const names = propNames({ $ref: `#/components/schemas/${name}` });
      for (const f of FORBIDDEN) expect([...names]).not.toContain(f);
    });
  }

  it("every /c response schema is free of staff-only fields", () => {
    for (const [path, item] of Object.entries<any>(doc.paths)) {
      if (!path.startsWith("/c/")) continue;
      for (const op of Object.values<any>(item)) {
        if (!op?.responses) continue;
        for (const res of Object.values<any>(op.responses)) {
          let r = res;
          if (r.$ref) r = doc.components.responses[r.$ref.split("/").pop()];
          const schema = r?.content?.["application/json"]?.schema;
          if (!schema) continue;
          const names = propNames(schema);
          for (const f of FORBIDDEN) expect([...names], `${path} leaks ${f}`).not.toContain(f);
        }
      }
    }
  });

  it("every /c and /s operation is tagged and has an operationId", () => {
    for (const [path, item] of Object.entries<any>(doc.paths)) {
      for (const [m, op] of Object.entries<any>(item)) {
        if (m === "parameters") continue;
        expect(op.operationId, `${m} ${path}`).toBeTruthy();
        if (path.startsWith("/c/")) expect(op.tags).toEqual(["customer"]);
        if (path.startsWith("/s/")) expect(op.tags).toEqual(["staff"]);
      }
    }
  });

  it("operationIds are unique", () => {
    const ids: string[] = [];
    for (const item of Object.values<any>(doc.paths))
      for (const [m, op] of Object.entries<any>(item)) if (m !== "parameters") ids.push(op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("Error schema is {code,message}", () => {
    expect(doc.components.schemas.Error.required).toEqual(["code", "message"]);
  });
});
