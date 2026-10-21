import { describe, expect, it } from "vitest";
import { CUSTOMER_A, LOC1, STAFF_MANAGER, STAFF_REP, V_COSTLY, V_GOOD, V_NOCOST, draftWith, ensureStaff, eventsOf, sent, submitted, useHarness } from "./helpers";

/** Contract 0.2.0 follow-ups API-13, 14, 15, 17, 18, 19, 20 plus submit-time routing (staff routes). */
describe("contract 0.2.0 staff follow-ups", () => {
  const h = useHarness();
  const DAY = 24 * 3600 * 1000;
  const ids = async (qs: string) => (await h.s.get(`/s/quotes?${qs}&limit=100`)).body.items.map((i: any) => i.id).sort();

  describe("API-14 inbox: rep filter, display-number search, itemCount, currencyCode", () => {
    it("rep=me, rep=unassigned (no rep and no team) and rep=<staffId>", async () => {
      const rep = await ensureStaff(h, STAFF_REP);
      const mgr = await ensureStaff(h, STAFF_MANAGER, { isManager: true });
      const open = await submitted(h); // no rep, no team
      const mine = await submitted(h);
      await h.s.post(`/s/quotes/${mine.id}/claim`);
      const teamOnly = await submitted(h);
      const team = await h.prisma.team.create({ data: { shop: h.deps.config.shopDomain, name: "Doors" } });
      await h.s.post(`/s/quotes/${teamOnly.id}/assign`, { teamId: team.id });
      const theirs = await submitted(h);
      await h.asStaff(STAFF_MANAGER).post(`/s/quotes/${theirs.id}/claim`);

      expect(await ids("rep=me")).toEqual([mine.id]);
      expect(await ids("rep=unassigned")).toEqual([open.id]); // teamOnly has a team, so it is not "unassigned"
      expect(await ids(`rep=${mgr.id}`)).toEqual([theirs.id]);
      expect(await ids(`rep=${rep.id}`)).toEqual([mine.id]);
      expect(await ids("rep=no-such-staff")).toEqual([]);
      expect(await ids("rep=unassigned&tab=needs_response")).toEqual([open.id]);
      expect(await ids(`team=${team.id}`)).toEqual([teamOnly.id]);
    });

    it("q matches the display number with or without the prefix, any case; other text still works", async () => {
      await ensureStaff(h, STAFF_REP);
      const a = await submitted(h);
      const b = await submitted(h);
      expect(a.number).not.toBe(b.number);
      for (const term of [`Q-${a.number}`, `q-${a.number}`, `q${a.number}`, `Q${a.number}`, String(a.number), a.displayNumber]) {
        expect(await ids(`q=${encodeURIComponent(term)}`), term).toEqual([a.id]);
      }
      expect(await ids(`q=${b.number}`)).toEqual([b.id]);
      expect(await ids("q=Q-99999")).toEqual([]);
      expect(await ids("q=job%20one")).toEqual([a.id, b.id].sort());
      expect(await ids("q=Acme")).toEqual([a.id, b.id].sort());
    });

    it("rows carry itemCount (number of lines, not units) and currencyCode", async () => {
      await ensureStaff(h, STAFF_REP);
      const q = await submitted(h, [{ variantId: V_GOOD, qty: 7 }, { variantId: V_COSTLY, qty: 3 }, { variantId: V_NOCOST, qty: 1 }]);
      const row = (await h.s.get("/s/quotes")).body.items.find((i: any) => i.id === q.id);
      expect(row).toMatchObject({ itemCount: 3, currencyCode: "USD" });
      expect((await h.s.get(`/s/quotes/${q.id}`)).body).toMatchObject({ itemCount: 3, currencyCode: "USD" });
      h.shopify.buyers.get(CUSTOMER_A)!.currencyCode = "CAD";
      const cad = await submitted(h);
      expect((await h.s.get("/s/quotes")).body.items.find((i: any) => i.id === cad.id).currencyCode).toBe("CAD");
      h.shopify.buyers.get(CUSTOMER_A)!.currencyCode = "USD";
    });
  });

  describe("API-15 summary tabCounts", () => {
    it("tabCounts has the six tabs and each equals the number of rows that tab lists", async () => {
      await ensureStaff(h, STAFF_REP);
      await draftWith(h); // a private customer draft is in no tab
      await submitted(h);
      await submitted(h);
      const claimed = await submitted(h);
      await h.s.post(`/s/quotes/${claimed.id}/claim`);
      await sent(h);
      const acc = await sent(h);
      await h.c.post(`/c/quotes/${acc.id}/accept`, {});
      h.clock.now = new Date(h.clock.now.getTime() + 12 * DAY); // the two sent quotes now expire within 3 days
      const sum = (await h.s.get("/s/reports/summary")).body;
      expect(Object.keys(sum.tabCounts).sort()).toEqual(["accepted", "all", "expiring", "needs_response", "unassigned", "waiting_customer"]);
      expect(sum.tabCounts).toEqual({ needs_response: 3, unassigned: 2, waiting_customer: 1, accepted: 1, expiring: 2, all: 5 }); // all = every non-draft quote
      for (const tab of Object.keys(sum.tabCounts)) {
        expect(sum.tabCounts[tab], tab).toBe((await ids(`tab=${tab}`)).length);
      }
      // the older tile fields agree with the tab counts
      expect(sum).toMatchObject({ needsResponse: 3, unassigned: 2, expiringSoon: 2 });
    });
  });

  describe("API-17 draft-revision snapshots price and cost for new variants (no /s/variants route)", () => {
    it("returns listPrice, cost, marginPct, belowFloor and costUnknown for a newly added variant", async () => {
      await ensureStaff(h, STAFF_REP);
      const q = await submitted(h, [{ variantId: V_COSTLY, qty: 1 }]);
      const r = await h.s.post(`/s/quotes/${q.id}/claim`);
      const keep = r.body.workingLines[0];
      const saved = await h.s.put(`/s/quotes/${q.id}/draft-revision`, {
        lines: [
          { id: keep.id, variantId: V_COSTLY, qty: 1, quotedPrice: "100.00" },
          { variantId: V_GOOD, qty: 4, quotedPrice: "40.00" },
          { variantId: V_NOCOST, qty: 2, quotedPrice: "9.00" },
        ],
      });
      expect(saved.status).toBe(200);
      const [costly, good, nocost] = saved.body.workingLines;
      expect(costly).toMatchObject({ listPrice: "100.00", cost: "90.00", costUnknown: false, belowFloor: true });
      expect(good).toMatchObject({ listPrice: "50.00", cost: "20.00", marginPct: 50, belowFloor: false, costUnknown: false, lineTotal: "160.00", addedBy: "STAFF" });
      expect(nocost).toMatchObject({ listPrice: "10.00", cost: null, marginPct: null, belowFloor: true, costUnknown: true });
      // The snapshot does not move when the catalog changes afterwards (rule 6).
      h.shopify.addVariant({ variantId: V_GOOD, price: "99.00", unitCost: "98.00", title: "Good Widget" });
      const again = await h.s.get(`/s/quotes/${q.id}`);
      expect(again.body.workingLines[1]).toMatchObject({ listPrice: "50.00", cost: "20.00" });
      // Unknown variant -> 422, and there is no variant lookup route at all.
      const bad = await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: [{ variantId: "gid://shopify/ProductVariant/404", qty: 1, quotedPrice: "1.00" }] });
      expect(bad.status).toBe(422);
      expect((await h.s.get("/s/variants/gid%3A%2F%2Fshopify%2FProductVariant%2F1")).status).toBe(404);
    });
  });

  describe("API-19 StaffQuote: paymentTerms, contact, workingExpiresAt, nextVersionNo", () => {
    it("paymentTerms, customerContactName and customerContactPhone come from the buyer at creation", async () => {
      await ensureStaff(h, STAFF_REP);
      const buyer = h.shopify.buyers.get(CUSTOMER_A)!;
      buyer.paymentTerms = "Net 30";
      buyer.phone = "+13125550999";
      const q = await submitted(h);
      const view = (await h.s.get(`/s/quotes/${q.id}`)).body;
      expect(view).toMatchObject({ paymentTerms: "Net 30", customerContactName: "Dana Dealer", customerContactPhone: "+13125550999" });
      // Not on any customer shape.
      expect(JSON.stringify((await h.c.get(`/c/quotes/${q.id}`)).body)).not.toMatch(/Net 30|13125550999|paymentTerms/);
      buyer.paymentTerms = undefined;
      buyer.phone = undefined;
      const plain = await submitted(h);
      expect((await h.s.get(`/s/quotes/${plain.id}`)).body).toMatchObject({ paymentTerms: null, customerContactPhone: null });
    });

    it("workingExpiresAt is saved by draft-revision, copied to expiresAt on send, else now + 14 days", async () => {
      await ensureStaff(h, STAFF_REP);
      const q = await submitted(h);
      await h.s.post(`/s/quotes/${q.id}/claim`);
      const wl = (await h.s.get(`/s/quotes/${q.id}`)).body.workingLines;
      const lines = wl.map((l: any) => ({ id: l.id, variantId: l.variantId, qty: l.qty, quotedPrice: l.quotedPrice }));
      const chosen = new Date(h.clock.now.getTime() + 30 * DAY).toISOString();
      const saved = await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines, expiresAt: chosen });
      expect(saved.body).toMatchObject({ workingExpiresAt: chosen, expiresAt: null });
      const v1 = await h.s.post(`/s/quotes/${q.id}/send`);
      expect(v1.body).toMatchObject({ expiresAt: chosen, workingExpiresAt: null });

      // Next revision with no chosen date: the default (QUOTE_DEFAULT_EXPIRY_DAYS = 14) from the moment of sending.
      await h.c.post(`/c/quotes/${q.id}/request-changes`, { message: "again" });
      h.clock.now = new Date(h.clock.now.getTime() + 2 * DAY);
      const v2 = await h.s.post(`/s/quotes/${q.id}/send`);
      expect(v2.body.expiresAt).toBe(new Date(h.clock.now.getTime() + 14 * DAY).toISOString());
      // A date in the past is refused at send time.
      await h.c.post(`/c/quotes/${q.id}/request-changes`, { message: "third" });
      await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines, expiresAt: new Date(h.clock.now.getTime() - DAY).toISOString() });
      expect((await h.s.post(`/s/quotes/${q.id}/send`)).status).toBe(422);
    });

    it("nextVersionNo = max(currentVersion, highest version) + 1, and send uses it", async () => {
      await ensureStaff(h, STAFF_REP);
      const q = await submitted(h);
      const fresh = (await h.s.post(`/s/quotes/${q.id}/claim`)).body;
      expect(fresh).toMatchObject({ currentVersion: 0, nextVersionNo: 1 });
      expect((await h.s.post(`/s/quotes/${q.id}/send`)).body).toMatchObject({ currentVersion: 1, nextVersionNo: 2 });

      // reopen / resend sequence
      await h.c.post(`/c/quotes/${q.id}/accept`, { versionNo: 1 });
      const reopened = await h.s.post(`/s/quotes/${q.id}/reopen`);
      expect(reopened.body).toMatchObject({ status: "IN_REVIEW", currentVersion: 1, nextVersionNo: 2 });
      expect((await h.s.post(`/s/quotes/${q.id}/send`)).body).toMatchObject({ currentVersion: 2, nextVersionNo: 3 });

      // A stored version number ahead of currentVersion (gap or data repair) wins: the next version never collides.
      const row = await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
      await h.prisma.quoteVersion.create({ data: { quoteId: q.id, versionNo: 5, subtotal: 1, total: 1 } });
      await h.c.post(`/c/quotes/${q.id}/request-changes`, { message: "more" });
      expect((await h.s.get(`/s/quotes/${q.id}`)).body).toMatchObject({ currentVersion: row.currentVersion, nextVersionNo: 6 });
      const sent6 = await h.s.post(`/s/quotes/${q.id}/send`);
      expect(sent6.status).toBe(200);
      expect(sent6.body).toMatchObject({ currentVersion: 6, nextVersionNo: 7 });
      expect(sent6.body.versions.map((v: any) => v.versionNo)).toEqual([1, 2, 5, 6]);
    });
  });

  describe("API-13 request-floor-approval", () => {
    async function belowFloor() {
      await ensureStaff(h, STAFF_REP, { name: "Rita Rep" });
      await ensureStaff(h, STAFF_MANAGER, { isManager: true });
      const q = await submitted(h, [{ variantId: V_GOOD, qty: 2 }, { variantId: V_NOCOST, qty: 1 }]);
      const claimed = (await h.s.post(`/s/quotes/${q.id}/claim`)).body;
      const good = claimed.workingLines.find((l: any) => l.variantId === V_GOOD);
      const nocost = claimed.workingLines.find((l: any) => l.variantId === V_NOCOST);
      await h.s.put(`/s/quotes/${q.id}/draft-revision`, {
        lines: [
          { id: good.id, variantId: V_GOOD, qty: 2, quotedPrice: "22.00" }, // 9% margin < 15% floor
          { id: nocost.id, variantId: V_NOCOST, qty: 1, quotedPrice: "10.00" }, // unknown cost
        ],
      });
      return { q, good, nocost };
    }

    it("writes a FLOOR_APPROVAL_REQUESTED event, changes no status, notifies no customer; repeatable", async () => {
      const { q, good, nocost } = await belowFloor();
      const r = await h.s.post(`/s/quotes/${q.id}/request-floor-approval`, { note: "Big account, please approve" });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe("IN_REVIEW");
      const ev = await eventsOf(h, q.id, "FLOOR_APPROVAL_REQUESTED");
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ actorType: "STAFF" });
      expect(ev[0]!.payload).toMatchObject({
        lineIds: [good.id, nocost.id],
        costUnknownLineIds: [nocost.id],
        note: "Big account, please approve",
        requester: { name: "Rita Rep" },
      });
      expect(r.body.events.map((e: any) => e.type)).toContain("FLOOR_APPROVAL_REQUESTED");
      // Safe to call again; each call writes another event.
      expect((await h.s.post(`/s/quotes/${q.id}/request-floor-approval`, { lineIds: [nocost.id] })).status).toBe(200);
      const all = await eventsOf(h, q.id, "FLOOR_APPROVAL_REQUESTED");
      expect(all).toHaveLength(2);
      expect(all[1]!.payload).toMatchObject({ lineIds: [nocost.id] });
      // The customer sees none of it, and the quote was not touched.
      expect(JSON.stringify((await h.c.get(`/c/quotes/${q.id}`)).body)).not.toMatch(/FLOOR|approval/i);
      expect((await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("IN_REVIEW");
      // A manager can still approve afterwards, and send then works.
      expect((await h.asStaff(STAFF_MANAGER).post(`/s/quotes/${q.id}/approve-floor`, {})).status).toBe(200);
      expect((await h.s.post(`/s/quotes/${q.id}/send`)).status).toBe(200);
    });

    it("refuses unknown line ids, a quote with nothing to approve, and quotes that are not being worked on", async () => {
      const { q, good } = await belowFloor();
      const bad = await h.s.post(`/s/quotes/${q.id}/request-floor-approval`, { lineIds: ["ghost"] });
      expect(bad.status).toBe(422);
      expect(bad.body.details.lineIds).toEqual(["ghost"]);
      await h.asStaff(STAFF_MANAGER).post(`/s/quotes/${q.id}/approve-floor`, {});
      const none = await h.s.post(`/s/quotes/${q.id}/request-floor-approval`, {});
      expect(none.status).toBe(422);
      expect(none.body.code).toBe("VALIDATION_FAILED");
      expect((await h.s.post(`/s/quotes/${q.id}/request-floor-approval`, { note: "x".repeat(2001) })).status).toBe(400);
      expect(await eventsOf(h, q.id, "FLOOR_APPROVAL_REQUESTED")).toHaveLength(0);
      expect((await h.s.post(`/s/quotes/no-such/request-floor-approval`, {})).status).toBe(404);

      await h.s.post(`/s/quotes/${q.id}/send`);
      await h.c.post(`/c/quotes/${q.id}/accept`, { versionNo: 1 });
      const late = await h.s.post(`/s/quotes/${q.id}/request-floor-approval`, { lineIds: [good.id] });
      expect(late.status).toBe(409);
      expect(late.body.code).toBe("NOT_EDITABLE");
    });

    it("approve-floor still needs a manager or admin (403 for a rep)", async () => {
      const { q } = await belowFloor();
      expect((await h.s.post(`/s/quotes/${q.id}/approve-floor`, {})).status).toBe(403);
      await ensureStaff(h, "5003", { role: "admin" });
      expect((await h.asStaff("5003").post(`/s/quotes/${q.id}/approve-floor`, {})).status).toBe(200);
    });
  });

  describe("API-20 POST /s/quotes/{id}/attachments/upload-url", () => {
    it("returns an upload target scoped to the quote and the file can then be attached to a staff message", async () => {
      await ensureStaff(h, STAFF_REP);
      const q = await submitted(h);
      const up = await h.s.post(`/s/quotes/${q.id}/attachments/upload-url`, { name: "Spec sheet.pdf", size: 1234, mime: "application/pdf" });
      expect(up.status).toBe(200);
      expect(up.body.uploadUrl).toMatch(/^https:\/\//);
      expect(up.body.fileUrl).toContain(`/quotes/${q.id}/`);
      expect(Date.parse(up.body.expiresAt)).toBeGreaterThan(h.clock.now.getTime());
      const msg = await h.s.post(`/s/quotes/${q.id}/messages`, { body: "Spec attached", attachments: [{ url: up.body.fileUrl, name: "Spec sheet.pdf", size: 1234, mime: "application/pdf" }] });
      expect(msg.status).toBe(201);
      expect(msg.body.attachments).toHaveLength(1);
      // The customer sees the attachment on a customer-visible message.
      expect((await h.c.get(`/c/quotes/${q.id}/messages`)).body.items[0].attachments[0].name).toBe("Spec sheet.pdf");
    });

    it("validates the request and the quote", async () => {
      await ensureStaff(h, STAFF_REP);
      const q = await submitted(h);
      expect((await h.s.post(`/s/quotes/${q.id}/attachments/upload-url`, { name: "x.pdf", size: 26214401, mime: "application/pdf" })).status).toBe(400);
      expect((await h.s.post(`/s/quotes/${q.id}/attachments/upload-url`, { name: "", size: 1, mime: "a/b" })).status).toBe(400);
      expect((await h.s.post(`/s/quotes/${q.id}/attachments/upload-url`, {})).status).toBe(400);
      expect((await h.s.post(`/s/quotes/nope/attachments/upload-url`, { name: "x.pdf", size: 1, mime: "application/pdf" })).status).toBe(404);
      expect((await h.raw({ method: "POST", url: `/s/quotes/${q.id}/attachments/upload-url`, payload: "{}" })).status).toBe(401);
      // A file uploaded for ANOTHER quote cannot be attached here.
      const other = await submitted(h);
      const up = await h.s.post(`/s/quotes/${other.id}/attachments/upload-url`, { name: "x.pdf", size: 1, mime: "application/pdf" });
      const bad = await h.s.post(`/s/quotes/${q.id}/messages`, { body: "wrong file", attachments: [{ url: up.body.fileUrl, name: "x.pdf", size: 1, mime: "application/pdf" }] });
      expect(bad.status).toBe(422);
    });
  });

  describe("settings-driven routing on submit", () => {
    async function setup(autoAssign: boolean) {
      const rep = await ensureStaff(h, STAFF_REP);
      await ensureStaff(h, STAFF_MANAGER, { isManager: true });
      const shop = h.deps.config.shopDomain;
      const ruleTeam = await h.prisma.team.create({ data: { shop, name: "Acme team" } });
      const defaultTeam = await h.prisma.team.create({ data: { shop, name: "General" } });
      await h.asStaff(STAFF_MANAGER).put("/s/settings", {
        defaultPriceFloorPct: 15,
        routing: { defaultTeamId: defaultTeam.id, autoAssignByCompany: autoAssign, rules: [{ companyId: "gid://shopify/Company/1", repId: rep.id, teamId: ruleTeam.id }] },
      });
      return { rep, ruleTeam, defaultTeam };
    }

    it("autoAssignByCompany on: the company's rule assigns rep and team on SUBMIT; other companies get the default team", async () => {
      const { rep, ruleTeam, defaultTeam } = await setup(true);
      const q = await submitted(h);
      expect(await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).toMatchObject({ status: "SUBMITTED", assignedRepId: rep.id, teamId: ruleTeam.id });
      expect(await eventsOf(h, q.id, "ASSIGN")).toHaveLength(0);
      const c = (await h.s.get(`/s/quotes/${q.id}`)).body;
      expect(c).toMatchObject({ assignedRepId: rep.id, teamId: ruleTeam.id });

      const other = await draftWith(h, [{ variantId: V_GOOD, qty: 1 }], h.asCustomer("gid://shopify/Customer/2001"));
      await h.asCustomer("gid://shopify/Customer/2001").post(`/c/quotes/${other.id}/submit`, {});
      expect(await h.prisma.quote.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({ assignedRepId: null, teamId: defaultTeam.id });
    });

    it("autoAssignByCompany off: rules are stored but ignored; the default team still applies", async () => {
      const { defaultTeam } = await setup(false);
      const q = await submitted(h);
      expect(await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).toMatchObject({ assignedRepId: null, teamId: defaultTeam.id });
      expect(await h.prisma.routingRule.count()).toBe(1);
    });

    it("from-cart submit and a staff-created submitted quote are routed too; an inactive rep is never auto-assigned", async () => {
      const { rep, ruleTeam } = await setup(true);
      const cart = await h.c.post("/c/quotes/from-cart", { cartLines: [{ variantId: V_GOOD, qty: 1 }], target: { mode: "new", title: "Cart" }, submit: true });
      expect(await h.prisma.quote.findUniqueOrThrow({ where: { id: cart.body.id } })).toMatchObject({ assignedRepId: rep.id, teamId: ruleTeam.id });

      await h.prisma.staff.update({ where: { id: rep.id }, data: { active: false } });
      const q = await submitted(h);
      expect(await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).toMatchObject({ assignedRepId: null, teamId: ruleTeam.id });

      const made = await h.asStaff(STAFF_MANAGER).post("/s/quotes", { customerId: CUSTOMER_A, companyLocationId: LOC1, title: "On behalf", lines: [{ variantId: V_GOOD, qty: 1 }], submit: true });
      expect(made.status).toBe(201);
      expect(made.body.status).toBe("SUBMITTED");
      expect(made.body.teamId).toBe(ruleTeam.id);
    });
  });
});
