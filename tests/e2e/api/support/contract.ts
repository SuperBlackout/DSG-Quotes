import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { REPO_ROOT } from "./env";

/**
 * QA-owned validator for docs/openapi.yaml (OpenAPI 3.0.3). Deliberately independent from apps/api/test/openapi.ts
 * so a bug in the backend's own checker cannot hide a contract violation.
 *
 * Strictness:
 *  - an object schema that declares `properties` rejects unknown keys unless `additionalProperties` is set
 *    (this is also what keeps cost/margin/internal fields out of the customer shapes);
 *  - `required`, `nullable`, `enum`, `pattern`, `format` (date, date-time, email, uri), min/max, minLength/maxLength,
 *    minItems, minProperties, allOf (union of properties), oneOf (exactly one branch) are enforced.
 */
export type Schema = Record<string, any>;
export const spec = parse(readFileSync(join(REPO_ROOT, "docs", "openapi.yaml"), "utf8")) as Schema;

export const METHODS = ["get", "post", "put", "patch", "delete"] as const;

export function deref<T extends Schema | undefined>(node: T): T {
  let cur: any = node;
  const seen = new Set<string>();
  while (cur && typeof cur === "object" && typeof cur.$ref === "string") {
    if (seen.has(cur.$ref)) throw new Error(`Circular $ref ${cur.$ref}`);
    seen.add(cur.$ref);
    const parts = cur.$ref.replace(/^#\//, "").split("/");
    const next = parts.reduce((acc: any, p: string) => acc?.[p], spec as any);
    if (!next) throw new Error(`Unresolved $ref ${cur.$ref}`);
    cur = next;
  }
  return cur;
}

interface Collected {
  props: Record<string, Schema>;
  required: string[];
  additional: boolean | Schema | undefined;
  hasObjectShape: boolean;
}

function collect(schemaIn: Schema): Collected {
  const s = deref(schemaIn)!;
  const out: Collected = { props: {}, required: [], additional: undefined, hasObjectShape: false };
  for (const sub of s.allOf ?? []) {
    const c = collect(sub);
    Object.assign(out.props, c.props);
    out.required.push(...c.required);
    if (c.additional !== undefined) out.additional = c.additional;
    out.hasObjectShape ||= c.hasObjectShape;
  }
  if (s.properties) {
    Object.assign(out.props, s.properties);
    out.hasObjectShape = true;
  }
  if (s.required) out.required.push(...s.required);
  if (s.additionalProperties !== undefined) out.additional = s.additionalProperties;
  if (s.type === "object") out.hasObjectShape = true;
  return out;
}

const isNullable = (s: Schema): boolean =>
  !!s.nullable || (Array.isArray(s.allOf) && s.allOf.some((x: Schema) => !!deref(x)?.nullable)) || (Array.isArray(s.oneOf) && s.oneOf.some((x: Schema) => !!deref(x)?.nullable));

/** Returns a list of human readable violations (empty = valid). */
export function validate(value: unknown, schemaIn: Schema, path = "$"): string[] {
  const schema = deref(schemaIn)!;
  if (value === null) return isNullable(schema) ? [] : [`${path}: null is not allowed`];
  if (value === undefined) return [`${path}: undefined`];
  const errs: string[] = [];

  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);

  if (schema.oneOf) {
    const results = schema.oneOf.map((sub: Schema) => validate(value, sub, path));
    const ok = results.filter((r: string[]) => r.length === 0).length;
    if (ok !== 1) errs.push(`${path}: matches ${ok} of ${schema.oneOf.length} oneOf branches (${results.map((r: string[]) => r[0] ?? "ok").join(" | ")})`);
    return errs;
  }

  const shape = collect(schema);
  const looksLikeObject = schema.type === "object" || shape.hasObjectShape;
  if (looksLikeObject) {
    if (typeof value !== "object" || Array.isArray(value)) return [...errs, `${path}: expected object, got ${Array.isArray(value) ? "array" : typeof value}`];
    const obj = value as Record<string, unknown>;
    for (const r of new Set(shape.required)) if (!(r in obj) || obj[r] === undefined) errs.push(`${path}.${r}: required property is missing`);
    if (schema.minProperties !== undefined && Object.keys(obj).length < schema.minProperties) errs.push(`${path}: needs at least ${schema.minProperties} properties`);
    const declared = Object.keys(shape.props).length > 0;
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      if (shape.props[k]) errs.push(...validate(v, shape.props[k]!, `${path}.${k}`));
      else if (shape.additional === true) continue;
      else if (shape.additional && typeof shape.additional === "object") errs.push(...validate(v, shape.additional, `${path}.${k}`));
      else if (declared || shape.additional === false) errs.push(`${path}.${k}: property is not in the contract`);
    }
    return errs;
  }

  switch (schema.type) {
    case "array": {
      if (!Array.isArray(value)) return [...errs, `${path}: expected array, got ${typeof value}`];
      if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${path}: fewer than ${schema.minItems} items`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${path}: more than ${schema.maxItems} items`);
      if (schema.items) value.forEach((v, i) => errs.push(...validate(v, schema.items, `${path}[${i}]`)));
      return errs;
    }
    case "string": {
      if (typeof value !== "string") return [...errs, `${path}: expected string, got ${typeof value}`];
      if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${path}: shorter than ${schema.minLength}`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${path}: longer than ${schema.maxLength}`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${path}: "${value}" does not match ${schema.pattern}`);
      if (schema.format === "date-time" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) errs.push(`${path}: "${value}" is not an RFC 3339 date-time`);
      if (schema.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) errs.push(`${path}: "${value}" is not a date`);
      if (schema.format === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) errs.push(`${path}: "${value}" is not an email`);
      if (schema.format === "uri" && !/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(value)) errs.push(`${path}: "${value}" is not a URI`);
      return errs;
    }
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return [...errs, `${path}: expected integer, got ${JSON.stringify(value)}`];
      if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: ${value} < minimum ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path}: ${value} > maximum ${schema.maximum}`);
      return errs;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return [...errs, `${path}: expected number, got ${JSON.stringify(value)}`];
      if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: ${value} < minimum ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path}: ${value} > maximum ${schema.maximum}`);
      return errs;
    case "boolean":
      return typeof value === "boolean" ? errs : [...errs, `${path}: expected boolean, got ${typeof value}`];
    default:
      return errs;
  }
}

// ------------------------------------------------------------------ operations

export interface Operation {
  method: string; // upper case
  path: string; // contract path, e.g. /c/quotes/{id}
  op: Schema;
}

export function operations(): Operation[] {
  const out: Operation[] = [];
  for (const [path, item] of Object.entries<Schema>(spec.paths)) {
    for (const m of METHODS) if (item[m]) out.push({ method: m.toUpperCase(), path, op: item[m] });
  }
  return out;
}

/** Fastify route pattern (e.g. /proxy/c/quotes/:id, /api/s/quotes/:id) -> contract path (/c/quotes/{id}). */
export function contractPath(routePattern: string): string {
  return routePattern.replace(/^\/proxy(?=\/c\/)/, "").replace(/^\/api(?=\/s\/)/, "").replace(/:(\w+)/g, "{$1}");
}

export function findOperation(method: string, routePattern: string): Operation | undefined {
  const path = contractPath(routePattern);
  const op = spec.paths?.[path]?.[method.toLowerCase()];
  return op ? { method: method.toUpperCase(), path, op } : undefined;
}

/** The schema a response with this status must satisfy: exact status, else `default` (errors only). */
export function responseSchema(op: Schema, status: number): { schema: Schema | null; declared: boolean; empty: boolean } {
  const responses = op.responses ?? {};
  let resp = responses[String(status)];
  if (!resp && status >= 400) resp = responses.default;
  if (!resp) return { schema: null, declared: false, empty: false };
  const r = deref(resp)!;
  const schema = r.content?.["application/json"]?.schema ?? null;
  return { schema, declared: true, empty: !r.content };
}

/** Validate a response. Returns violations; also flags undeclared success statuses. */
export function validateResponse(method: string, routePattern: string, status: number, body: unknown): string[] {
  const found = findOperation(method, routePattern);
  if (!found) return [`no operation for ${method} ${contractPath(routePattern)} in docs/openapi.yaml`];
  const { schema, declared, empty } = responseSchema(found.op, status);
  if (!declared) return [`${method} ${found.path}: status ${status} is not declared in the contract`];
  if (status >= 400) return validate(body, spec.components.schemas.Error);
  if (!schema) return empty && (body === undefined || body === "") ? [] : empty ? [`${method} ${found.path} ${status}: contract declares no body, got ${JSON.stringify(body).slice(0, 80)}`] : [];
  return validate(body, schema);
}

/**
 * The response Content-Type must be one the contract declares for that status (e.g. `application/pdf` for the PDF route,
 * `application/json` elsewhere). Errors fall under `default`, which is JSON. Returns a message, or null when fine.
 */
export function checkMediaType(method: string, routePattern: string, status: number, contentType: string): string | null {
  const found = findOperation(method, routePattern);
  if (!found) return null;
  const responses = found.op.responses ?? {};
  const resp = responses[String(status)] ?? (status >= 400 ? responses.default : undefined);
  if (!resp) return null;
  const declared = Object.keys(deref(resp)?.content ?? {});
  if (declared.length === 0) return contentType ? `contract declares no body for ${status} but the response has Content-Type ${contentType}` : null;
  const actual = contentType.split(";")[0]!.trim().toLowerCase();
  return declared.includes(actual) ? null : `Content-Type ${actual || "(none)"} is not one of the declared ${declared.join(", ")}`;
}

/** Validate a request body the test sent (only meaningful when the API accepted it). */
export function validateRequestBody(method: string, routePattern: string, body: unknown): string[] {
  const found = findOperation(method, routePattern);
  if (!found) return [];
  const rb = deref(found.op.requestBody);
  const schema = rb?.content?.["application/json"]?.schema;
  if (!schema) return [];
  if (body === undefined) return rb.required ? ["request body is required by the contract"] : [];
  return validate(body, schema, "$request");
}
