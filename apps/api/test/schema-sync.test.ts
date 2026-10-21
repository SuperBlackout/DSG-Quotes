import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useHarness } from "./helpers";

/**
 * Migrations are hand-maintained SQL (the Prisma schema engine binary can't be downloaded in the sandbox).
 * This test makes drift between prisma/schema.prisma and prisma/migrations impossible to miss: every model
 * field must exist as a column with the same nullability, and every enum value must exist in Postgres.
 * (The generated client's runtime DMMF is stripped, so the .prisma file itself is parsed.)
 */
const schemaText = readFileSync(join(__dirname, "..", "prisma", "schema.prisma"), "utf8").replace(/\/\/.*$/gm, "");

function blocks(kind: "model" | "enum"): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = new RegExp(`^${kind}\\s+(\\w+)\\s*\\{([\\s\\S]*?)^\\}`, "gm");
  for (let m = re.exec(schemaText); m; m = re.exec(schemaText)) {
    out.set(m[1]!, m[2]!.split("\n").map((l) => l.trim()).filter(Boolean));
  }
  return out;
}

describe("prisma/schema.prisma <-> prisma/migrations", () => {
  const h = useHarness();
  const models = blocks("model");
  const enums = blocks("enum");

  it("parses the schema (sanity)", () => {
    expect(models.size).toBeGreaterThanOrEqual(12);
    expect(enums.get("QuoteStatus")).toHaveLength(10);
  });

  it("every model has a table and every scalar field a column with matching nullability", async () => {
    const cols = await h.prisma.$queryRaw<{ table_name: string; column_name: string; is_nullable: string }[]>`
      SELECT table_name::text AS table_name, column_name::text AS column_name, is_nullable::text AS is_nullable
      FROM information_schema.columns WHERE table_schema = 'public'`;
    const byTable = new Map<string, Map<string, boolean>>();
    for (const c of cols) {
      if (!byTable.has(c.table_name)) byTable.set(c.table_name, new Map());
      byTable.get(c.table_name)!.set(c.column_name, c.is_nullable === "YES");
    }
    const problems: string[] = [];
    for (const [name, lines] of models) {
      const table = byTable.get(name);
      if (!table) {
        problems.push(`missing table ${name}`);
        continue;
      }
      const seen = new Set<string>();
      for (const line of lines) {
        if (line.startsWith("@@")) continue;
        const m = /^(\w+)\s+(\w+)(\?|\[\])?/.exec(line);
        if (!m) continue;
        const [, field, type, mod] = m as unknown as [string, string, string, string | undefined];
        if (models.has(type) || mod === "[]") continue; // relation
        seen.add(field);
        const nullable = table.get(field);
        if (nullable === undefined) problems.push(`${name}.${field}: missing column`);
        else if (nullable !== (mod === "?")) problems.push(`${name}.${field}: db nullable=${nullable} but schema says ${mod === "?" ? "optional" : "required"}`);
      }
      const dbOnly = [...table.keys()].filter((c) => !seen.has(c));
      if (dbOnly.length) problems.push(`${name}: columns not in schema: ${dbOnly.join(", ")}`);
    }
    const extraTables = [...byTable.keys()].filter((t) => !models.has(t));
    expect(problems).toEqual([]);
    expect(extraTables).toEqual([]);
  });

  it("every enum value exists in Postgres", async () => {
    const rows = await h.prisma.$queryRaw<{ typname: string; enumlabel: string }[]>`
      SELECT t.typname::text AS typname, e.enumlabel::text AS enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid`;
    for (const [name, values] of enums) {
      const labels = rows.filter((r) => r.typname === name).map((r) => r.enumlabel).sort();
      expect(labels, name).toEqual([...values].sort());
    }
  });

  it("every @@unique / @@index in the schema exists as an index", async () => {
    const q = await h.prisma.$queryRaw<{ indexname: string }[]>`SELECT indexname::text AS indexname FROM pg_indexes WHERE schemaname='public'`;
    const names = new Set(q.map((r) => r.indexname));
    const missing: string[] = [];
    for (const [model, lines] of models) {
      for (const line of lines) {
        const m = /^@@(unique|index)\(\[([^\]]+)\]/.exec(line);
        if (!m) continue;
        const cols = m[2]!.split(",").map((s) => s.trim());
        const expected = `${model}_${cols.join("_")}_${m[1] === "unique" ? "key" : "idx"}`;
        if (!names.has(expected)) missing.push(expected);
      }
    }
    expect(missing).toEqual([]);
  });
});
