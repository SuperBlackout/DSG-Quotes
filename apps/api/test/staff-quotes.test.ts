import { describe, expect, it } from "vitest";
import {
  CUSTOMER_A,
  STAFF_MANAGER,
  STAFF_REP,
  V_COSTLY,
  V_GOOD,
  V_NOCOST,
  draftWith,
  ensureStaff,
  eventsOf,
  sent,
  submitted,
  useHarness,
} from "./helpers";

describe("staff quotes", () => {
  const h = useHarness();
  const DAY = 24 * 3600 * 1000;

  describe("inbox", () => {
    it("GET /s/quotes: tabs, filters, search and paging; customer drafts are not shown", async () => {
      await ensureStaff(h, STAFF_REP);
      const draft = await draftWith(h); // private customer draft: never in the inbox
      const needs = await submitted(h);
      const ready = await sent(h);
      const accepted = await sent(h);
      await h.c.post(`/c/quotes/${accepted.id}/accept`, {});

      const all = await h.s.get("/s/quotes");
      expect(all.status).toBe(200);
      expect(all.body.items.map((i: any) => i.id)).not.toContain(draft.id);
      expect(all.body.items).toHaveLength(3);
      expect(all.body.items[0]).toHaveProperty("customerName", "Dana Dealer");
      expect(all.body.items[0]).toHaveProperty("companyName", "Acme Dealers");

      const ids = async (qs: string) => (await h.s.get(`/s/quotes?${qs}`)).body.items.map((i: any) => i.id).sort();
      expect(await ids("tab=needs_response")).toEqual([needs.id]);
      expect(await ids("tab=unassigned")).toEqual([needs.id]);
      expect(await ids("tab=waiting_customer")).toEqual([ready.id]);
      expect(await ids("tab=accepted")).toEqual([accepted.id]);
      expect(await ids("tab=expiring")).toEqual([]);
      h.clock.now = new Date(h.clock.now.getTime() + 12 * DAY); // 2 days before the 14-day expiry
      expect(await ids("tab=expiring")).toEqual([ready.id, accepted.id].sort());
      h.clock.now = new Date(h.clock.now.getTime() - 12 * DAY);

      expect(await ids("rep=me")).toEqual([ready.id, accepted.id].sort());
      expect(await ids("q=job%20one")).toHaveLength(3);
      expect(await ids(`q=${needs.displayNumber}`)).toEqual([needs.id]);
      expect(await ids("q=nomatch")).toEqual([]);
      const p1 = await h.s.get("/s/quotes?limit=2");
      expect(p1.body.items).toHaveLength(2);
      const p2 = await h.s.get(`/s/quotes?limit=2&cursor=${p1.body.nextCursor}`);
      expect(p2.body.items).toHaveLength(1);
      expect((await h.s.get("/s/quotes?tab=bogus")).status).toBe(400);
    });

    it("exposes waiting timer, margin and floor flag on rows", async () => {
      await ensureStaff(h, STAFF_REP);
      const q = await submitted(h, [{ variantId: V_COSTLY, qty: 1 }]); // 10% margin < 15% floor
      const row = (await h.s.get("/s/quotes")).body.items.find((i: any) => i.id === q.id);
      expect(row).toMatchObject({ status: "SUBMITTED", waitingOn: "sales", belowFloor: true, marginPct: 10, total: "100.00" });
      expect(row.waitingSince).toBe(h.clock.now.toISOString());
    });

    it("GET /s/reports/summary returns the inbox tiles", async () => {
      await ensureStaff(h, STAFF_REP);
      await submitted(h);
      const b = await sent(h, [{ variantId: V_GOOD, qty: 4 }]); // 200.00
      const c = await sent(h, [{ variantId: V_GOOD, qty: 1 }]); // 50.00
      await h.c.post(`/c/quotes/${c.id}/accept`, {});
      h.clock.now = new Date(h.clock.now.getTime() + 12 * DAY);
      const r = await h.s.get("/s/reports/summary");
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        needsResponse: 1,
        unassigned: 1,
        acceptedThisWeek: 0,
        expiringSoon: 2,
      });
      expect(r.body.openValue).toBe("350.00"); // 100 (submitted) + 200 + 50
      h.clock.now = new Date("2026-03-02T15:00:00.000Z");
      const fresh = await h.s.get("/s/reports/summary");
      expect(fresh.body).toMatchObject({ acceptedThisWeek: 1, acceptedThisWeekValue: "50.00" });
      expect(b.id).toBeTruthy();
    });
  });

  describe("read / create", () => {
    it("GET /s/quotes/:id returns cost, margin, internal notes, working lines, versions, events", async () => {
      await ensureStaff(h, STAFF_REP);
      const q = await submitted(h, [{ variantId: V_GOOD, qty: 2 }]);
      const r = await h.s.get(`/s/quotes/${q.id}`);
      expect(r.status).toBe(200);
      expect(r.body.workingLines[0]).toMatchObject({ cost: "20.00", marginPct: 60, belowFloor: false, listPrice: "50.00", quotedPrice: "50.00" });
      expect(r.body).toMatchObject({ customerId: CUSTOMER_A, companyName: "Acme Dealers", workingFreight: "0.00", draftOrderId: null, latestChangeRequest: null });
      expect(r.body.events.map((e: any) => e.type)).toEqual(["CREATE", "SUBMIT"]);
      expect((await h.s.get("/s/quotes/nope")).status).toBe(404);
    });

    it("POST /s/quotes creates on behalf of a customer (optionally submitted and assigned to the creator)", async () => {
      const staff = await ensureStaff(h, STAFF_REP);
      const draft = await h.s.post("/s/quotes", { customerId: CUSTOMER_A, title: "Phone order", newJob: { name: "Phone job" }, lines: [{ variantId: V_GOOD, qty: 2 }] });
      expect(draft.status).toBe(201);
      expect(draft.body).toMatchObject({ status: "DRAFT", customerName: "Dana Dealer", customerId: CUSTOMER_A, total: "100.00" });
      expect(draft.body.workingLines[0]).toMatchObject({ addedBy: "STAFF", cost: "20.00" });
      expect((await h.s.get("/s/quotes")).body.items.map((i: any) => i.id)).toContain(draft.body.id); // rep-created drafts are listed
      // ...and the customer can see and submit it.
      expect((await h.c.get(`/c/quotes/${draft.body.id}`)).status).toBe(200);

      const sub = await h.s.post("/s/quotes", { customerId: CUSTOMER_A, title: "Go", lines: [{ variantId: V_GOOD, qty: 1 }], submit: true });
      expect(sub.body).toMatchObject({ status: "SUBMITTED", assignedRepId: staff.id });
      expect((await eventsOf(h, sub.body.id, "SUBMIT"))[0]).toMatchObject({ actorType: "STAFF", actorId: staff.id });

      const noLines = await h.s.post("/s/quotes", { customerId: CUSTOMER_A, title: "Empty", submit: true });
      expect(noLines.status).toBe(422);
      const nobody = await h.s.post("/s/quotes", { customerId: "gid://shopify/Customer/404", title: "x" });
      expect(nobody.status).toBe(422);
      const wrongLoc = await h.s.post("/s/quotes", { customerId: CUSTOMER_A, title: "x", companyLocationId: "gid://shopify/CompanyLocation/3" });
      expect(wrongLoc.status).toBe(422);
    });
  });

  describe("ownership", () => {
    it("claim: SUBMITTED -> IN_REVIEW assigned to me; re-claim by another rep only reassigns", async () => {
      const rep = await ensureStaff(h, STAFF_REP);
      const other = await ensureStaff(h, "5009");
      const q = await submitted(h);
      const r = await h.s.post(`/s/quotes/${q.id}/claim`);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: "IN_REVIEW", assignedRepId: rep.id, assignedRepName: rep.name });
      const ev = await eventsOf(h, q.id, "CLAIM");
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ actorType: "STAFF", actorId: rep.id });

      const steal = await h.asStaff("5009").post(`/s/quotes/${q.id}/claim`);
      expect(steal.body).toMatchObject({ status: "IN_REVIEW", assignedRepId: other.id });
      expect(await eventsOf(h, q.id, "ASSIGN")).toHaveLength(1);

      const draft = await draftWith(h);
      const refused = await h.s.post(`/s/quotes/${draft.id}/claim`);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("INVALID_TRANSITION");
    });

    it("assign: sets rep and/or team without changing status", async () => {
      const rep = await ensureStaff(h, STAFF_REP);
      const q = await submitted(h);
      const r = await h.s.post(`/s/quotes/${q.id}/assign`, { repId: rep.id, teamId: "team-east" });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: "SUBMITTED", assignedRepId: rep.id, teamId: "team-east" });
      expect((await h.s.get("/s/quotes?team=team-east")).body.items).toHaveLength(1);
      expect((await h.s.get("/s/quotes?team=other")).body.items).toHaveLength(0);
      const cleared = await h.s.post(`/s/quotes/${q.id}/assign`, { repId: null });
      expect(cleared.body.assignedRepId).toBeNull();
      expect((await h.s.post(`/s/quotes/${q.id}/assign`, { repId: "ghost" })).status).toBe(422);
      expect((await h.s.post(`/s/quotes/${q.id}/assign`, {})).status).toBe(400);
    });
  });

  describe("draft revision and send", () => {
    it("PUT draft-revision stores working lines/freight/notes/expiry, invisible to the customer", async () => {
      await ensureStaff(h, STAFF_REP);
      const q = await submitted(h, [{ variantId: V_GOOD, qty: 2 }]);
      await h.s.post(`/s/quotes/${q.id}/claim`);
      const view = (await h.s.get(`/s/quotes/${q.id}`)).body;
      const line = view.workingLines[0];
      const expiresAt = new Date(h.clock.now.getTime() + 30 * DAY).toISOString();
      const r = await h.s.put(`/s/quotes/${q.id}/draft-revision`, {
        lines: [
          { id: line.id, variantId: V_GOOD, qty: 4, quotedPrice: "45.00", lineNote: "volume price" },
          { variantId: V_NOCOST, qty: 10, quotedPrice: "9.50" },
        ],
        freight: "25.00",
        expiresAt,
        repNote: "Prices good for 30 days",
        internalNote: "Margin is fine, customer is big",
      });
      expect(r.status).toBe(200);
      expect(r.body.workingLines).toHaveLength(2);
      expect(r.body.workingLines[0]).toMatchObject({ id: line.id, qty: 4, quotedPrice: "45.00", lineTotal: "180.00", lineNote: "volume price", marginPct: 55.56 });
      expect(r.body.workingLines[1]).toMatchObject({ qty: 10, quotedPrice: "9.50", listPrice: "10.00", cost: null, addedBy: "STAFF" });
      // The working expiry is its own field; `expiresAt` stays null until a version is sent.
      expect(r.body).toMatchObject({ workingFreight: "25.00", workingRepNote: "Prices good for 30 days", workingInternalNote: "Margin is fine, customer is big", workingExpiresAt: expiresAt, expiresAt: null });

      // Customer still sees ONLY their original request.
      const cust = (await h.c.get(`/c/quotes/${q.id}`)).body;
      expect(cust.lines).toHaveLength(1);
      expect(cust.lines[0]).toMatchObject({ qty: 2, quotedPrice: "50.00" });
      expect(cust.total).toBe("100.00");
      expect(JSON.stringify(cust)).not.toContain("volume price");

      // Removing a line by omitting it.
      const r2 = await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: [{ id: line.id, variantId: V_GOOD, qty: 4, quotedPrice: "45.00" }] });
      expect(r2.body.workingLines).toHaveLength(1);
    });

    it("draft-revision validates ids, product swaps, amounts and status", async () => {
      await ensureStaff(h, STAFF_REP);
      const q = await submitted(h);
      const line = (await h.s.get(`/s/quotes/${q.id}`)).body.workingLines[0];
      expect((await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: [{ id: "ghost", variantId: V_GOOD, qty: 1, quotedPrice: "1.00" }] })).status).toBe(422);
      expect((await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: [{ id: line.id, variantId: V_NOCOST, qty: 1, quotedPrice: "1.00" }] })).status).toBe(422);
      expect((await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: [{ id: line.id, variantId: V_GOOD, qty: 1, quotedPrice: "abc" }] })).status).toBe(400);
      expect((await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: [{ variantId: "gid://shopify/ProductVariant/404", qty: 1, quotedPrice: "1.00" }] })).status).toBe(422);
      const draft = await draftWith(h);
      const locked = await h.s.put(`/s/quotes/${draft.id}/draft-revision`, { lines: [] });
      expect(locked.status).toBe(409);
      expect(locked.body.code).toBe("NOT_EDITABLE");
      expect((await h.s.put(`/s/quotes/nope/draft-revision`, { lines: [] })).status).toBe(404);
    });

    it("send: freezes version 1, QUOTE_READY, default expiry +14 days, price snapshot, one event, customer sees it", async () => {
      const rep = await ensureStaff(h, STAFF_REP);
      const q = await submitted(h, [{ variantId: V_GOOD, qty: 2 }]);
      await h.s.post(`/s/quotes/${q.id}/claim`);
      const line = (await h.s.get(`/s/quotes/${q.id}`)).body.workingLines[0];
      await h.s.put(`/s/quotes/${q.id}/draft-revision`, {
        lines: [{ id: line.id, variantId: V_GOOD, qty: 2, quotedPrice: "44.00", lineNote: "intro price" }],
        freight: "12.50",
        repNote: "Thanks for the order",
        internalNote: "SECRET internal",
      });
      const r = await h.s.post(`/s/quotes/${q.id}/send`);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: "QUOTE_READY", currentVersion: 1, total: "100.50", assignedRepId: rep.id });
      expect(r.body.expiresAt).toBe(new Date(h.clock.now.getTime() + 14 * DAY).toISOString());
      expect(r.body.versions).toHaveLength(1);
      expect(r.body.versions[0]).toMatchObject({ versionNo: 1, subtotal: "88.00", discountTotal: "12.00", freight: "12.50", total: "100.50", repNote: "Thanks for the order", internalNote: "SECRET internal", marginPct: 54.55, sentById: rep.id });
      expect(r.body.versions[0].lines[0]).toMatchObject({ quotedPrice: "44.00", listPrice: "50.00", cost: "20.00" });

      const ev = await eventsOf(h, q.id, "SEND_REVISION");
      expect(ev).toHaveLength(1);
      expect(ev[0]!.payload).toMatchObject({ from: "IN_REVIEW", to: "QUOTE_READY", versionNo: 1, total: "100.50" });

      const cust = (await h.c.get(`/c/quotes/${q.id}`)).body;
      expect(cust).toMatchObject({ status: "QUOTE_READY", waitingOn: "customer", currentVersion: 1, total: "100.50" });
      expect(cust.lines[0]).toMatchObject({ quotedPrice: "44.00", listPrice: "50.00", lineNote: "intro price" });
      expect(cust.versions[0]).toMatchObject({ versionNo: 1, freight: "12.50", repNote: "Thanks for the order" });
      expect(cust.assignedRepName).toBe(rep.name);
    });

    it("send v2 after a change request: customer sees both versions (diff), stale accept is refused", async () => {
      await ensureStaff(h, STAFF_REP);
      const v1 = await sent(h, [{ variantId: V_GOOD, qty: 2 }]);
      await h.c.post(`/c/quotes/${v1.id}/request-changes`, { message: "Need a better price" });
      const staffView = (await h.s.get(`/s/quotes/${v1.id}`)).body;
      expect(staffView).toMatchObject({ status: "CHANGES_REQUESTED", latestChangeRequest: "Need a better price" });
      await h.s.post(`/s/quotes/${v1.id}/claim`);
      const line = staffView.workingLines[0];
      await h.s.put(`/s/quotes/${v1.id}/draft-revision`, { lines: [{ id: line.id, variantId: V_GOOD, qty: 2, quotedPrice: "40.00" }] });
      const v2 = await h.s.post(`/s/quotes/${v1.id}/send`);
      expect(v2.status).toBe(200);
      expect(v2.body).toMatchObject({ status: "QUOTE_READY", currentVersion: 2, total: "80.00" });
      expect(v2.body.expiresAt).toBe(new Date(h.clock.now.getTime() + 14 * DAY).toISOString());
      const cust = (await h.c.get(`/c/quotes/${v1.id}`)).body;
      expect(cust.versions.map((v: any) => [v.versionNo, v.total])).toEqual([[1, "100.00"], [2, "80.00"]]);
      expect(cust.lines[0].quotedPrice).toBe("40.00");
      const stale = await h.c.post(`/c/quotes/${v1.id}/accept`, { versionNo: 1 });
      expect(stale.body.code).toBe("VERSION_MISMATCH");
      expect((await h.c.post(`/c/quotes/${v1.id}/accept`, { versionNo: 2 })).status).toBe(200);
    });

    it("send honours a rep-chosen expiry once, then falls back to +14 days", async () => {
      await ensureStaff(h, STAFF_REP);
      const q = await submitted(h);
      const line = (await h.s.get(`/s/quotes/${q.id}`)).body.workingLines[0];
      const expiresAt = new Date(h.clock.now.getTime() + 5 * DAY).toISOString();
      await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: [{ id: line.id, variantId: V_GOOD, qty: 2, quotedPrice: "50.00" }], expiresAt });
      expect((await h.s.post(`/s/quotes/${q.id}/send`)).body.expiresAt).toBe(expiresAt);
      await h.c.post(`/c/quotes/${q.id}/request-changes`, { message: "again" });
      expect((await h.s.post(`/s/quotes/${q.id}/send`)).body.expiresAt).toBe(new Date(h.clock.now.getTime() + 14 * DAY).toISOString());
    });

    it("send refuses a past expiry, an empty revision and non-sendable statuses", async () => {
      await ensureStaff(h, STAFF_REP);
      const q = await submitted(h);
      const line = (await h.s.get(`/s/quotes/${q.id}`)).body.workingLines[0];
      await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: [{ id: line.id, variantId: V_GOOD, qty: 2, quotedPrice: "50.00" }], expiresAt: new Date(h.clock.now.getTime() - DAY).toISOString() });
      const past = await h.s.post(`/s/quotes/${q.id}/send`);
      expect(past.status).toBe(422);
      expect(past.body.code).toBe("VALIDATION_FAILED");
      await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: [] });
      expect((await h.s.post(`/s/quotes/${q.id}/send`)).status).toBe(422);
      const draft = await draftWith(h);
      const bad = await h.s.post(`/s/quotes/${draft.id}/send`);
      expect(bad.status).toBe(409);
      expect(bad.body.code).toBe("INVALID_TRANSITION");
      expect((await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("SUBMITTED");
    });
  });

  describe("price floor", () => {
    async function belowFloorQuote() {
      await ensureStaff(h, STAFF_REP, { priceFloorPct: 15 });
      await ensureStaff(h, STAFF_MANAGER, { isManager: true });
      const q = await submitted(h, [{ variantId: V_GOOD, qty: 2 }]); // cost 20, price 50
      await h.s.post(`/s/quotes/${q.id}/claim`);
      const line = (await h.s.get(`/s/quotes/${q.id}`)).body.workingLines[0];
      // 22.00 vs cost 20.00 = 9.09% margin < 15% floor
      await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: [{ id: line.id, variantId: V_GOOD, qty: 2, quotedPrice: "22.00" }] });
      return { q, line };
    }

    it("send is blocked with 422 FLOOR_APPROVAL_REQUIRED listing the lines, and nothing is written", async () => {
      const { q, line } = await belowFloorQuote();
      const r = await h.s.post(`/s/quotes/${q.id}/send`);
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ code: "FLOOR_APPROVAL_REQUIRED", details: { lineIds: [line.id] } });
      const row = await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
      expect(row.status).toBe("IN_REVIEW");
      expect(await h.prisma.quoteVersion.count({ where: { quoteId: q.id } })).toBe(0);
      expect(await eventsOf(h, q.id, "SEND_REVISION")).toHaveLength(0);
      const view = (await h.s.get(`/s/quotes/${q.id}`)).body;
      expect(view.belowFloor).toBe(true);
      expect(view.workingLines[0]).toMatchObject({ belowFloor: true, floorApproved: false });
    });

    it("approve-floor is manager only; once approved the send succeeds", async () => {
      const { q, line } = await belowFloorQuote();
      const denied = await h.s.post(`/s/quotes/${q.id}/approve-floor`, {});
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe("FORBIDDEN");

      const mgr = h.asStaff(STAFF_MANAGER);
      const approved = await mgr.post(`/s/quotes/${q.id}/approve-floor`, { note: "Strategic account" });
      expect(approved.status).toBe(200);
      expect(approved.body.workingLines[0]).toMatchObject({ id: line.id, belowFloor: true, floorApproved: true });
      expect(approved.body.belowFloor).toBe(false);
      const ev = await eventsOf(h, q.id, "FLOOR_APPROVED");
      expect(ev[0]!.payload).toMatchObject({ lineIds: [line.id], note: "Strategic account" });

      const sentRes = await h.s.post(`/s/quotes/${q.id}/send`);
      expect(sentRes.status).toBe(200);
      expect(sentRes.body.versions[0].lines[0].floorApproved).toBe(true);
    });

    it("approval is per price: changing the price afterwards needs a fresh approval", async () => {
      const { q, line } = await belowFloorQuote();
      const mgr = h.asStaff(STAFF_MANAGER);
      await mgr.post(`/s/quotes/${q.id}/approve-floor`, { lineIds: [line.id] });
      await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: [{ id: line.id, variantId: V_GOOD, qty: 2, quotedPrice: "21.00" }] });
      expect((await h.s.post(`/s/quotes/${q.id}/send`)).status).toBe(422);
      expect((await mgr.post(`/s/quotes/${q.id}/approve-floor`, { lineIds: ["ghost"] })).status).toBe(422);
      await mgr.post(`/s/quotes/${q.id}/approve-floor`, {});
      expect((await h.s.post(`/s/quotes/${q.id}/send`)).status).toBe(200);
    });

    it("a line exactly on the floor does not block", async () => {
      await ensureStaff(h, STAFF_REP, { priceFloorPct: 15 });
      const q = await submitted(h, [{ variantId: V_GOOD, qty: 1 }]);
      const lines = (await h.s.get(`/s/quotes/${q.id}`)).body.workingLines;
      // 23.53 on cost 20.00 = 15.0% margin: exactly on the floor is allowed (strictly below blocks).
      const saved = await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: [{ id: lines[0].id, variantId: V_GOOD, qty: 1, quotedPrice: "23.53" }] });
      expect(saved.body.workingLines[0]).toMatchObject({ belowFloor: false, costUnknown: false });
      expect((await h.s.post(`/s/quotes/${q.id}/send`)).status).toBe(200);
    });

    describe("unknown cost (costUnknown) always needs manager approval", () => {
      async function unknownCostQuote() {
        await ensureStaff(h, STAFF_REP, { priceFloorPct: 0 }); // even a 0% floor cannot clear a line whose cost is unknown
        await ensureStaff(h, STAFF_MANAGER, { isManager: true });
        const q = await submitted(h, [{ variantId: V_GOOD, qty: 1 }, { variantId: V_NOCOST, qty: 1 }]);
        const claimed = await h.s.post(`/s/quotes/${q.id}/claim`);
        const line = claimed.body.workingLines.find((l: any) => l.variantId === V_NOCOST);
        return { q, line, good: claimed.body.workingLines.find((l: any) => l.variantId === V_GOOD) };
      }

      it("the line is flagged: costUnknown, marginPct null, belowFloor true; the quote row is belowFloor", async () => {
        const { q, line, good } = await unknownCostQuote();
        expect(line).toMatchObject({ cost: null, costUnknown: true, marginPct: null, belowFloor: true, floorApproved: false });
        expect(good).toMatchObject({ costUnknown: false, belowFloor: false });
        const row = (await h.s.get("/s/quotes")).body.items.find((i: any) => i.id === q.id);
        expect(row.belowFloor).toBe(true);
      });

      it("send returns 422 FLOOR_APPROVAL_REQUIRED with the line ids until a manager approves; then it sends", async () => {
        const { q, line } = await unknownCostQuote();
        const blocked = await h.s.post(`/s/quotes/${q.id}/send`);
        expect(blocked.status).toBe(422);
        expect(blocked.body).toMatchObject({ code: "FLOOR_APPROVAL_REQUIRED", details: { lineIds: [line.id], costUnknownLineIds: [line.id] } });
        expect(await h.prisma.quoteVersion.count({ where: { quoteId: q.id } })).toBe(0);

        expect((await h.s.post(`/s/quotes/${q.id}/approve-floor`, {})).status).toBe(403); // a rep cannot approve
        const approved = await h.asStaff(STAFF_MANAGER).post(`/s/quotes/${q.id}/approve-floor`, { lineIds: [line.id] });
        expect(approved.status).toBe(200);
        expect(approved.body.workingLines.find((l: any) => l.id === line.id)).toMatchObject({ costUnknown: true, floorApproved: true });
        expect(approved.body.belowFloor).toBe(false);
        expect((await h.s.post(`/s/quotes/${q.id}/send`)).status).toBe(200);
      });

      it("editing the price or quantity of an approved unknown-cost line needs a fresh approval", async () => {
        const { q, line, good } = await unknownCostQuote();
        const mgr = h.asStaff(STAFF_MANAGER);
        await mgr.post(`/s/quotes/${q.id}/approve-floor`, {});
        await h.s.put(`/s/quotes/${q.id}/draft-revision`, {
          lines: [
            { id: good.id, variantId: V_GOOD, qty: 1, quotedPrice: "50.00" },
            { id: line.id, variantId: V_NOCOST, qty: 2, quotedPrice: "10.00" },
          ],
        });
        expect((await h.s.post(`/s/quotes/${q.id}/send`)).status).toBe(422);
        await mgr.post(`/s/quotes/${q.id}/approve-floor`, {});
        expect((await h.s.post(`/s/quotes/${q.id}/send`)).status).toBe(200);
      });

      it("a product added through draft-revision without a stored cost is flagged in the response too", async () => {
        const { q } = await unknownCostQuote();
        const added = await h.s.put(`/s/quotes/${q.id}/draft-revision`, { lines: [{ variantId: V_NOCOST, qty: 3, quotedPrice: "9.00" }] });
        expect(added.status).toBe(200);
        expect(added.body.workingLines).toHaveLength(1);
        expect(added.body.workingLines[0]).toMatchObject({ listPrice: "10.00", cost: null, costUnknown: true, marginPct: null, belowFloor: true });
      });

      it("the customer never sees costUnknown, cost or any approval flag", async () => {
        const { q } = await unknownCostQuote();
        await h.asStaff(STAFF_MANAGER).post(`/s/quotes/${q.id}/approve-floor`, {});
        await h.s.post(`/s/quotes/${q.id}/send`);
        const cust = JSON.stringify((await h.c.get(`/c/quotes/${q.id}`)).body);
        for (const k of ["costUnknown", "floorApproved", "belowFloor", "marginPct", '"cost"']) expect(cust).not.toContain(k);
      });
    });
  });

  describe("reopen / decline", () => {
    it("staff reopen: ACCEPTED -> IN_REVIEW and the old draft order is discarded", async () => {
      await ensureStaff(h, STAFF_REP);
      const q = await sent(h);
      await h.c.post(`/c/quotes/${q.id}/accept`, {});
      await h.c.post(`/c/quotes/${q.id}/checkout`);
      const stored = await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
      const r = await h.s.post(`/s/quotes/${q.id}/reopen`);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: "IN_REVIEW", draftOrderId: null });
      expect(h.shopify.deletedDraftOrders).toEqual([stored.draftOrderId]);
      const ev = await eventsOf(h, q.id, "REOPEN");
      expect(ev).toHaveLength(1);
      expect(ev[0]!.payload).toMatchObject({ previousDraftOrderId: stored.draftOrderId });
      const again = await h.s.post(`/s/quotes/${q.id}/reopen`);
      expect(again.status).toBe(409);
    });

    it("staff decline: closes the quote, reason shown to the customer", async () => {
      await ensureStaff(h, STAFF_REP);
      const q = await submitted(h);
      const r = await h.s.post(`/s/quotes/${q.id}/decline`, { reason: "We can't supply this item" });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe("DECLINED");
      expect((await h.c.get(`/c/quotes/${q.id}`)).body.messages.map((m: any) => m.body)).toEqual(["We can't supply this item"]);
      expect((await eventsOf(h, q.id, "DECLINE"))[0]).toMatchObject({ actorType: "STAFF" });
      expect((await h.s.post(`/s/quotes/${q.id}/decline`, {})).status).toBe(409);
    });
  });

  describe("conversation", () => {
    it("staff posts to the customer (event) and internal notes (no event, never visible to the customer)", async () => {
      const rep = await ensureStaff(h, STAFF_REP, { name: "Rita Rep" });
      const q = await submitted(h);
      const pub = await h.s.post(`/s/quotes/${q.id}/messages`, { body: "Looking at this now" });
      expect(pub.status).toBe(201);
      expect(pub.body).toMatchObject({ internal: false, authorType: "STAFF", authorName: "Rita Rep", authorId: rep.id });
      const note = await h.s.post(`/s/quotes/${q.id}/messages`, { body: "INTERNAL: margin is thin", internal: true });
      expect(note.body.internal).toBe(true);

      expect(await eventsOf(h, q.id, "NEW_MESSAGE")).toHaveLength(1);
      const staffList = await h.s.get(`/s/quotes/${q.id}/messages`);
      expect(staffList.body.items.map((m: any) => m.body)).toEqual(["Looking at this now", "INTERNAL: margin is thin"]);
      const custList = await h.c.get(`/c/quotes/${q.id}/messages`);
      expect(custList.body.items.map((m: any) => m.body)).toEqual(["Looking at this now"]);
      expect(JSON.stringify((await h.c.get(`/c/quotes/${q.id}`)).body)).not.toContain("INTERNAL");

      const page1 = await h.s.get(`/s/quotes/${q.id}/messages?limit=1`);
      expect(page1.body.items).toHaveLength(1);
      const page2 = await h.s.get(`/s/quotes/${q.id}/messages?limit=1&cursor=${page1.body.nextCursor}`);
      expect(page2.body.items[0].internal).toBe(true);
      expect((await h.s.post(`/s/quotes/${q.id}/messages`, { body: "" })).status).toBe(400);
      expect((await h.s.get("/s/quotes/nope/messages")).status).toBe(404);
    });
  });
});
