import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { customerLine, customerMessage, customerQuote, customerSummary, customerVersion } from "../src/serializers/customer";
import { validate } from "./openapi";
import { STAFF_MANAGER, STAFF_REP, V_COSTLY, V_GOOD, V_NOCOST, draftWith, ensureStaff, sent, submitted, useHarness } from "./helpers";

const FORBIDDEN_KEYS = [
  "cost", "unitCost", "margin", "marginPct", "marginTotal", "internalNote", "workingInternalNote", "workingRepNote",
  "workingFreight", "workingLines", "belowFloor", "floorApproved", "floorApprovedById", "internal", "customerEmail",
  "latestChangeRequest", "createdByStaffId", "draftOrderInvoiceUrl", "priceFloorPct",
];
const SECRETS = ["SECRET-INTERNAL-NOTE", "SECRET-QUOTE-INTERNAL", "SECRET-THIN-MARGIN", "SECRET-WORKING-NOTE"];

function walk(value: unknown, visit: (key: string, v: unknown, path: string) => void, path = "$") {
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, visit, `${path}[${i}]`));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      visit(k, v, `${path}.${k}`);
      walk(v, visit, `${path}.${k}`);
    }
  }
}

function assertCustomerSafe(label: string, body: unknown, costs: string[]) {
  const text = JSON.stringify(body);
  walk(body, (k, _v, path) => {
    expect(FORBIDDEN_KEYS, `${label}: forbidden key "${k}" at ${path}`).not.toContain(k);
  });
  for (const s of SECRETS) expect(text, `${label} leaked "${s}"`).not.toContain(s);
  for (const c of costs) expect(text, `${label} leaked cost ${c}`).not.toContain(`"${c}"`);
}

describe("customer serializer privacy (CLAUDE.md rules 4 and 5)", () => {
  const h = useHarness();

  async function scenario() {
    await ensureStaff(h, STAFF_REP, { name: "Rita Rep" });
    await ensureStaff(h, STAFF_MANAGER, { isManager: true });
    h.shopify.addVariant({ variantId: V_COSTLY, price: "100.00", unitCost: "73.17", title: "Costly Widget" });
    h.shopify.addVariant({ variantId: V_GOOD, price: "50.00", unitCost: "21.43", title: "Good Widget" });
    const q = await submitted(h, [{ variantId: V_COSTLY, qty: 1 }, { variantId: V_GOOD, qty: 2 }, { variantId: V_NOCOST, qty: 1 }]);
    await h.s.post(`/s/quotes/${q.id}/claim`);
    const wl = (await h.s.get(`/s/quotes/${q.id}`)).body.workingLines;
    await h.s.put(`/s/quotes/${q.id}/draft-revision`, {
      lines: wl.map((l: any) => ({ id: l.id, variantId: l.variantId, qty: l.qty, quotedPrice: l.variantId === V_COSTLY ? "80.00" : l.quotedPrice })), // 8.5% margin: below floor
      freight: "10.00",
      repNote: "Customer-visible note",
      internalNote: "SECRET-INTERNAL-NOTE",
    });
    await h.asStaff(STAFF_MANAGER).post(`/s/quotes/${q.id}/approve-floor`, { note: "SECRET-THIN-MARGIN" });
    await h.s.post(`/s/quotes/${q.id}/messages`, { body: "SECRET-QUOTE-INTERNAL: they will accept anything", internal: true });
    await h.s.post(`/s/quotes/${q.id}/messages`, { body: "Hi Dana, v1 is ready" });
    const r = await h.s.post(`/s/quotes/${q.id}/send`);
    expect(r.status).toBe(200);
    // A second internal note AFTER sending, and a working edit that must not leak before the next send.
    await h.s.post(`/s/quotes/${q.id}/messages`, { body: "SECRET-QUOTE-INTERNAL again", internal: true });
    const wl2 = (await h.s.get(`/s/quotes/${q.id}`)).body.workingLines;
    await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: wl2.map((l: any) => ({ id: l.id, variantId: l.variantId, qty: l.qty, quotedPrice: l.quotedPrice })), internalNote: "SECRET-WORKING-NOTE", repNote: "SECRET-WORKING-NOTE" });
    await h.c.post(`/c/quotes/${q.id}/messages`, { body: "Thanks!" });
    return q.id as string;
  }

  it("no customer endpoint ever returns cost, margin, floor data, internal notes or internal messages", async () => {
    const id = await scenario();
    const draft = await draftWith(h, [{ variantId: V_COSTLY, qty: 1 }]);
    const costs = ["73.17", "21.43"]; // distinct from every price and total in this scenario

    const responses: [string, any][] = [];
    const get = async (label: string, p: Promise<{ status: number; body: any }>) => {
      const r = await p;
      expect(r.status, label).toBeLessThan(300);
      responses.push([label, r.body]);
    };
    await get("GET /c/quotes", h.c.get("/c/quotes"));
    await get("GET /c/quotes/:id (sent)", h.c.get(`/c/quotes/${id}`));
    await get("GET /c/quotes/:id (draft)", h.c.get(`/c/quotes/${draft.id}`));
    await get("GET messages", h.c.get(`/c/quotes/${id}/messages`));
    await get("POST message", h.c.post(`/c/quotes/${id}/messages`, { body: "one more" }));
    await get("PATCH header", h.c.patch(`/c/quotes/${draft.id}`, { title: "t2" }));
    await get("POST line", h.c.post(`/c/quotes/${draft.id}/lines`, { variantId: V_GOOD, qty: 1 }));
    await get("duplicate", h.c.post(`/c/quotes/${id}/duplicate`));
    await get("request-changes", h.c.post(`/c/quotes/${id}/request-changes`, { message: "please adjust" }));
    await get("GET active-quote", h.c.get("/c/active-quote"));
    await get("GET notification-prefs", h.c.get("/c/notification-prefs"));

    expect(responses.length).toBeGreaterThan(8);
    for (const [label, body] of responses) assertCustomerSafe(label, body, costs);

    // The customer sees the sent version's prices, not the working edits.
    const view = responses.find(([l]) => l === "GET /c/quotes/:id (sent)")![1];
    expect(view.versions).toHaveLength(1);
    expect(view.versions[0].repNote).toBe("Customer-visible note");
    expect(view.lines.find((l: any) => l.variantId === V_COSTLY).quotedPrice).toBe("80.00");
    expect(view.messages.map((m: any) => m.body)).toEqual(["Hi Dana, v1 is ready", "Thanks!"]);
  });

  it("the same data DOES reach staff routes (so the privacy test above is meaningful)", async () => {
    const id = await scenario();
    const staff = JSON.stringify((await h.s.get(`/s/quotes/${id}`)).body);
    for (const s of ["73.17", "SECRET-INTERNAL-NOTE", "SECRET-QUOTE-INTERNAL", "SECRET-WORKING-NOTE", "marginPct", "belowFloor"]) expect(staff).toContain(s);
  });

  it("serializer functions ignore sensitive columns even when handed a full database row", () => {
    const D = (v: string) => new Prisma.Decimal(v);
    const now = new Date("2026-03-02T15:00:00Z");
    const line: any = {
      id: "l1", quoteId: "q1", versionId: null, set: "CUSTOMER", variantId: "v", sku: "S", title: "T", imageUrl: null, qty: 2,
      listPrice: D("10"), quotedPrice: D("9"), cost: D("1.11"), lineNote: null, floorApproved: true, floorApprovedById: "x", addedBy: "STAFF", position: 1,
    };
    const out = customerLine(line);
    expect(Object.keys(out).sort()).toEqual(["id", "imageUrl", "lineNote", "lineTotal", "listPrice", "position", "qty", "quotedPrice", "sku", "title", "variantId"]);
    expect(JSON.stringify(out)).not.toContain("1.11");

    const version: any = { id: "ver", quoteId: "q1", versionNo: 1, sentById: "staff", sentAt: now, subtotal: D("18"), discountTotal: D("2"), freight: D("0"), taxEstimate: null, total: D("18"), repNote: "n", internalNote: "SECRET-INTERNAL-NOTE", lines: [line] };
    const v = customerVersion(version);
    expect(v).not.toHaveProperty("internalNote");
    expect(v).not.toHaveProperty("sentById");
    expect(JSON.stringify(v)).not.toContain("SECRET");

    const msgs: any[] = [
      { id: "m1", authorType: "STAFF", authorId: "s", authorName: "R", body: "public", internal: false, attachments: [], channel: "WEB", readAt: null, createdAt: now },
      { id: "m2", authorType: "STAFF", authorId: "s", authorName: "R", body: "SECRET-INTERNAL-NOTE", internal: true, attachments: [], channel: "WEB", readAt: null, createdAt: now },
    ];
    expect(customerMessage(msgs[0])).not.toHaveProperty("internal");
    const quote: any = {
      id: "q1", shop: "s", number: 10001, title: "Q", status: "QUOTE_READY", currentVersion: 1, customerName: "C", customerEmail: "x@y.z", expiresAt: null, total: D("18"), lineCount: 1,
      marginPct: D("12"), belowFloor: true, workingInternalNote: "SECRET-INTERNAL-NOTE", workingFreight: D("5"), job: null, updatedAt: now, orderId: null, poNumber: null, neededBy: null, shipToAddress: null, notesToSales: null, watchers: [],
    };
    const full = customerQuote({ quote, extras: { assignedRepName: "Rita", unreadCount: 0, previousTotal: null }, lines: [line], versions: [version], messages: msgs }, now);
    // Even if a caller passes an internal message in by mistake, it is dropped.
    expect(full.messages.map((m) => m.body)).toEqual(["public"]);
    expect(JSON.stringify(full)).not.toContain("SECRET");
    expect(JSON.stringify(customerSummary(quote, now))).not.toMatch(/marginPct|belowFloor|workingInternalNote|customerEmail/);
  });

  it("the contract validator really rejects a leaked field (guards the conformance check itself)", () => {
    const leaky = { id: "l", variantId: "v", title: "t", qty: 1, listPrice: "1.00", quotedPrice: "1.00", lineTotal: "1.00", position: 1, cost: "0.50" };
    const errs = validate(leaky, { $ref: "#/components/schemas/CustomerQuoteLine" });
    expect(errs.join()).toContain("cost: not in contract");
    expect(validate({ ...leaky, cost: undefined }, { $ref: "#/components/schemas/CustomerQuoteLine" })).toEqual([]);
    expect(validate({ ...leaky, cost: undefined, quotedPrice: "1.5" }, { $ref: "#/components/schemas/CustomerQuoteLine" }).join()).toContain("quotedPrice");
  });

  it("internal staff notes never create events (so the worker cannot notify the customer)", async () => {
    await ensureStaff(h, STAFF_REP);
    const q = await submitted(h);
    await h.s.post(`/s/quotes/${q.id}/messages`, { body: "internal only", internal: true });
    expect(await h.prisma.event.count({ where: { quoteId: q.id, type: "NEW_MESSAGE" } })).toBe(0);
    await h.s.post(`/s/quotes/${q.id}/messages`, { body: "public reply" });
    expect(await h.prisma.event.count({ where: { quoteId: q.id, type: "NEW_MESSAGE" } })).toBe(1);
    expect(await sent(h)).toBeTruthy();
  });
});
