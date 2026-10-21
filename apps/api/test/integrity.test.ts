import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { signShopifyWebhook } from "../src/auth/crypto";
import { applyTransition, lockQuote } from "../src/domain/transitions";
import { SECRET, SHOP, STAFF_REP, V_GOOD, draftWith, ensureStaff, eventsOf, useHarness } from "./helpers";

const API_ROOT = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === "node_modules" || name === "migrations") return [];
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** `status:` or shorthand `status,` as an object key (not a property access like `x.status`). */
const STATUS_KEY = /(?<![.\w])status\s*[:,}]/;
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Extract the `{...}` after every `data:`; returns each object body. */
function dataObjects(src: string): string[] {
  const out: string[] = [];
  const re = /\bdata\s*:\s*\{/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    out.push(src.slice(start, i + 1));
  }
  return out;
}

describe("status is only ever written by transition() (CLAUDE.md rule 1, CI grep check)", () => {
  const files = [...sourceFiles(join(API_ROOT, "src")), join(API_ROOT, "prisma", "seed.ts")].filter((f) => !f.endsWith(join("domain", "transitions.ts")));

  it("scans a meaningful number of source files", () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it("no Prisma `data:` object outside domain/transitions.ts contains a `status` key", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = stripComments(readFileSync(f, "utf8"));
      for (const obj of dataObjects(src)) {
        if (STATUS_KEY.test(obj)) offenders.push(`${relative(API_ROOT, f)}: ${obj.slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no raw SQL updates a quote status, and nothing calls status-writing helpers directly", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = stripComments(readFileSync(f, "utf8"));
      if (/UPDATE\s+"Quote"/i.test(src) || /SET\s+"status"/i.test(src)) offenders.push(relative(API_ROOT, f));
    }
    expect(offenders).toEqual([]);
  });

  it("the guard itself works: it flags a data object that sets status", () => {
    const bad = stripComments("await tx.quote.update({ where: { id }, data: { title: 'x', status: 'ACCEPTED' } });");
    expect(dataObjects(bad).some((o) => STATUS_KEY.test(o))).toBe(true);
    const ok = stripComments("await tx.quote.findMany({ where: { status: { in: ['A'] } }, data: { title: 'x' } });");
    expect(dataObjects(ok).some((o) => STATUS_KEY.test(o))).toBe(false);
  });
});

describe("transition + event are atomic", () => {
  const h = useHarness();

  it("a failure after the status update rolls the status back (no half-applied transition)", async () => {
    const q = await draftWith(h);
    await expect(
      h.prisma.$transaction(async (tx) => {
        const quote = (await lockQuote(tx, q.id))!;
        const broken = new Proxy(tx, {
          get: (t, p) => (p === "event" ? { create: async () => { throw new Error("event insert failed"); } } : (t as any)[p]),
        });
        await applyTransition(broken as typeof tx, { quote, event: "SUBMIT", actor: "customer", actorId: "c", now: h.clock.now });
      }),
    ).rejects.toThrow("event insert failed");
    expect((await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("DRAFT");
    expect(await eventsOf(h, q.id, "SUBMIT")).toHaveLength(0);
  });

  it("a failure after the event insert also rolls the event back", async () => {
    const q = await draftWith(h);
    await expect(
      h.prisma.$transaction(async (tx) => {
        const quote = (await lockQuote(tx, q.id))!;
        await applyTransition(tx, { quote, event: "SUBMIT", actor: "customer", actorId: "c", now: h.clock.now });
        throw new Error("later step failed");
      }),
    ).rejects.toThrow("later step failed");
    expect((await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("DRAFT");
    expect(await eventsOf(h, q.id, "SUBMIT")).toHaveLength(0);
  });

  it("a refused transition changes nothing and writes no event", async () => {
    const q = await draftWith(h);
    const before = await h.prisma.event.count({ where: { quoteId: q.id } });
    for (const path of ["accept", "withdraw", "request-changes", "reopen"]) {
      const r = await h.c.post(`/c/quotes/${q.id}/${path}`, { message: "x" });
      expect(r.status, path).toBe(409);
      expect(r.body.code, path).toBe("INVALID_TRANSITION");
    }
    expect(await h.prisma.event.count({ where: { quoteId: q.id } })).toBe(before);
    expect((await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("DRAFT");
  });

  it("customers cannot invoke staff-only transitions and staff cannot invoke customer-only ones", async () => {
    await ensureStaff(h, STAFF_REP);
    const q = await draftWith(h);
    await h.c.post(`/c/quotes/${q.id}/submit`, {});
    // No customer route exists for CLAIM / SEND_REVISION (staff routes only)...
    expect((await h.c.post(`/c/quotes/${q.id}/claim`)).status).toBe(404);
    expect((await h.c.post(`/c/quotes/${q.id}/send`)).status).toBe(404);
    // ...and staff cannot accept on the customer's behalf.
    expect((await h.s.post(`/s/quotes/${q.id}/accept`, {})).status).toBe(404);
  });

  it("a full lifecycle leaves exactly one event per status change, forming an unbroken from->to chain", async () => {
    await ensureStaff(h, STAFF_REP);
    const q = await draftWith(h, [{ variantId: V_GOOD, qty: 2 }]);
    const id = q.id;
    const ok = async (p: Promise<{ status: number; text: string }>) => {
      const r = await p;
      if (r.status >= 300) throw new Error(r.text);
    };
    await ok(h.c.post(`/c/quotes/${id}/submit`, {})); // DRAFT -> SUBMITTED
    await ok(h.c.post(`/c/quotes/${id}/withdraw`)); // -> DRAFT
    await ok(h.c.post(`/c/quotes/${id}/submit`, {})); // -> SUBMITTED
    await ok(h.s.post(`/s/quotes/${id}/claim`)); // -> IN_REVIEW
    await ok(h.s.post(`/s/quotes/${id}/send`)); // -> QUOTE_READY v1
    await ok(h.c.post(`/c/quotes/${id}/request-changes`, { message: "lower?" })); // -> CHANGES_REQUESTED
    await ok(h.s.post(`/s/quotes/${id}/send`)); // -> QUOTE_READY v2 (straight from CHANGES_REQUESTED)
    await ok(h.c.post(`/c/quotes/${id}/accept`, { versionNo: 2 })); // -> ACCEPTED
    await ok(h.c.post(`/c/quotes/${id}/reopen`)); // -> IN_REVIEW
    await ok(h.s.post(`/s/quotes/${id}/send`)); // -> QUOTE_READY v3
    await ok(h.c.post(`/c/quotes/${id}/accept`, { versionNo: 3 })); // -> ACCEPTED
    await ok(h.c.post(`/c/quotes/${id}/checkout`));
    const raw = JSON.stringify({ id: 1, admin_graphql_api_id: "gid://shopify/Order/1", tags: `quote:Q-${q.number}` });
    await ok(h.raw({ method: "POST", url: "/webhooks/shopify", headers: { "content-type": "application/json", "x-shopify-topic": "orders/create", "x-shopify-shop-domain": SHOP, "x-shopify-webhook-id": "w1", "x-shopify-hmac-sha256": signShopifyWebhook(raw, SECRET) }, payload: raw }) as any);

    const events = await h.prisma.event.findMany({ where: { quoteId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    const changes = events.filter((e) => (e.payload as any)?.from && (e.payload as any)?.to);
    expect(changes.map((e) => `${(e.payload as any).from}>${(e.payload as any).to}`)).toEqual([
      "DRAFT>SUBMITTED", "SUBMITTED>DRAFT", "DRAFT>SUBMITTED", "SUBMITTED>IN_REVIEW", "IN_REVIEW>QUOTE_READY", "QUOTE_READY>CHANGES_REQUESTED",
      "CHANGES_REQUESTED>QUOTE_READY", "QUOTE_READY>ACCEPTED", "ACCEPTED>IN_REVIEW", "IN_REVIEW>QUOTE_READY", "QUOTE_READY>ACCEPTED", "ACCEPTED>ORDERED",
    ]);
    // chain continuity + final state
    let cur = "DRAFT";
    for (const e of changes) {
      expect((e.payload as any).from).toBe(cur);
      cur = (e.payload as any).to;
    }
    expect((await h.prisma.quote.findUniqueOrThrow({ where: { id } })).status).toBe(cur);
    expect(cur).toBe("ORDERED");
    expect(await h.prisma.quoteVersion.count({ where: { quoteId: id } })).toBe(3);
  });

  it("two simultaneous submits on the same draft produce exactly one SUBMIT (row lock + state machine)", async () => {
    const q = await draftWith(h);
    const [a, b] = await Promise.all([h.c.post(`/c/quotes/${q.id}/submit`, {}), h.c.post(`/c/quotes/${q.id}/submit`, {})]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await eventsOf(h, q.id, "SUBMIT")).toHaveLength(1);
  });
});
