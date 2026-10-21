import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * Minimal OpenAPI 3.0 response validator, enough for docs/openapi.yaml: $ref, allOf, type, nullable, enum,
 * required, properties (unknown keys are errors unless additionalProperties is set), items, pattern, date formats.
 * Every response in the integration tests is validated against the contract (see helpers.ts).
 */
type Schema = Record<string, any>;
const spec = parse(readFileSync(join(__dirname, "..", "..", "..", "docs", "openapi.yaml"), "utf8")) as Schema;

function resolve(node: Schema | undefined): Schema | undefined {
  let cur = node;
  while (cur && typeof cur.$ref === "string") {
    const parts = cur.$ref.replace(/^#\//, "").split("/");
    cur = parts.reduce<any>((acc, p) => acc?.[p], spec);
    if (!cur) throw new Error(`Unresolved $ref ${node?.$ref}`);
  }
  return cur;
}

function collect(schema: Schema): { props: Record<string, Schema>; required: string[]; additional: boolean | Schema; parts: Schema[] } {
  const s = resolve(schema)!;
  const out = { props: {} as Record<string, Schema>, required: [] as string[], additional: false as boolean | Schema, parts: [] as Schema[] };
  if (s.allOf) {
    for (const sub of s.allOf) {
      const c = collect(sub);
      Object.assign(out.props, c.props);
      out.required.push(...c.required);
      if (c.additional) out.additional = c.additional;
      out.parts.push(...c.parts);
    }
  }
  if (s.properties) Object.assign(out.props, s.properties);
  if (s.required) out.required.push(...s.required);
  if (s.additionalProperties) out.additional = s.additionalProperties;
  out.parts.push(s);
  return out;
}

export function validate(value: unknown, schemaIn: Schema, path = "$"): string[] {
  const schema = resolve(schemaIn)!;
  const errs: string[] = [];
  if (value === null) {
    if (schema.nullable) return [];
    // allOf-wrapped nullable (e.g. job/shipTo)
    return schema.allOf?.some((s: Schema) => resolve(s)?.nullable) ? [] : [`${path}: null not allowed`];
  }
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: ${JSON.stringify(value)} not in enum`);

  const isObjectSchema = schema.type === "object" || schema.properties || schema.allOf;
  if (isObjectSchema) {
    if (typeof value !== "object" || Array.isArray(value)) return [`${path}: expected object`];
    const { props, required, additional } = collect(schema);
    const obj = value as Record<string, unknown>;
    for (const r of required) if (!(r in obj)) errs.push(`${path}.${r}: required`);
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      if (props[k]) errs.push(...validate(v, props[k]!, `${path}.${k}`));
      else if (additional === true) continue;
      else if (additional) errs.push(...validate(v, additional as Schema, `${path}.${k}`));
      else errs.push(`${path}.${k}: not in contract`);
    }
    return errs;
  }
  switch (schema.type) {
    case "array": {
      if (!Array.isArray(value)) return [`${path}: expected array`];
      if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${path}: too few items`);
      if (schema.items) value.forEach((v, i) => errs.push(...validate(v, schema.items, `${path}[${i}]`)));
      return errs;
    }
    case "string":
      if (typeof value !== "string") return [`${path}: expected string, got ${typeof value}`];
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${path}: "${value}" does not match ${schema.pattern}`);
      if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) errs.push(`${path}: bad date-time`);
      if (schema.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) errs.push(`${path}: bad date`);
      if (schema.format === "email" && !/^[^@\s]+@[^@\s]+$/.test(value)) errs.push(`${path}: bad email`);
      if (schema.format === "uri" && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) errs.push(`${path}: bad uri`);
      return errs;
    case "integer":
      return Number.isInteger(value) ? [] : [`${path}: expected integer`];
    case "number":
      return typeof value === "number" ? [] : [`${path}: expected number`];
    case "boolean":
      return typeof value === "boolean" ? [] : [`${path}: expected boolean`];
    default:
      return errs;
  }
}

/** Convert a Fastify route pattern to the contract's path: strip /proxy and /api prefixes, :id -> {id}. */
export function contractPath(routeUrl: string): string {
  return routeUrl.replace(/^\/proxy(?=\/c\/)/, "").replace(/^\/api(?=\/s\/)/, "").replace(/:(\w+)/g, "{$1}");
}

export function hasOperation(method: string, routeUrl: string): boolean {
  return !!spec.paths?.[contractPath(routeUrl)]?.[method.toLowerCase()];
}

/** Validate a response body against the operation's declared response (or the Error schema for 4xx/5xx). */
export function validateResponse(method: string, routeUrl: string, status: number, body: unknown): string[] {
  const op = spec.paths?.[contractPath(routeUrl)]?.[method.toLowerCase()];
  if (!op) return [`no operation for ${method} ${contractPath(routeUrl)}`];
  if (status >= 400) return validate(body, spec.components.schemas.Error);
  const resp = resolve(op.responses?.[String(status)]);
  if (!resp) return [`${method} ${contractPath(routeUrl)}: status ${status} is not declared in the contract`];
  const schema = resp.content?.["application/json"]?.schema;
  if (!schema) return body === undefined || body === "" ? [] : [`expected empty body for ${status}`];
  return validate(body, schema);
}

export function contractOperations(): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [];
  for (const [path, item] of Object.entries<Schema>(spec.paths)) {
    for (const m of ["get", "post", "put", "patch", "delete"]) if (item[m]) out.push({ method: m.toUpperCase(), path });
  }
  return out;
}
