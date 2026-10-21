import { describe, expect, it } from "vitest";
import { CUSTOMER_A, LOC1, V_COSTLY, V_GOOD, V_NOCOST, draftWith, eventsOf, sent, submitted, useHarness } from "./helpers";

describe("customer quotes", () => {
  const h = useHarness();

  it("POST /c/quotes creates a numbered draft, a job, and sets it active", async () => {
    const r = await h.c.post("/c/quotes", { title: "Kitchen remodel", newJob: { name: "Smith kitchen", poNumber: "PO-77", siteAddress: "1 Main St" }, neededBy: "2026-04-01" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      number: 10001,
      displayNumber: "Q-10001",
      title: "Kitchen remodel",
      status: "DRAFT",
      waitingOn: "customer",
      lineCount: 0,
      total: "0.00",
      neededBy: "2026-04-01",
      poNumber: "PO-77",
      job: { name: "Smith kitchen", poNumber: "PO-77" },
      ownerName: "Dana Dealer",
      lines: [],
      versions: [],
      messages: [],
    });
    expect(r.body.actions).toMatchObject({ canEditLines: true, canSubmit: false, canDelete: true, canBuy: false });
    const active = await h.c.get("/c/active-quote");
    expect(active.body).toMatchObject({ quoteId: r.body.id, number: 10001 });
    const second = await h.c.post("/c/quotes", { title: "Second" });
    expect(second.body.number).toBe(10002);
    expect((await h.c.get("/c/active-quote")).body.quoteId).toBe(second.body.id);
  });

  it("POST /c/quotes with setActive=false leaves the active quote alone, and rejects a bad body", async () => {
    const a = await h.c.post("/c/quotes", { title: "A" });
    await h.c.post("/c/quotes", { title: "B", setActive: false });
    expect((await h.c.get("/c/active-quote")).body.quoteId).toBe(a.body.id);
    const bad = await h.c.post("/c/quotes", { title: "" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("BAD_REQUEST");
  });

  it("reuses an existing job by id and rejects a job from another company", async () => {
    const first = await h.c.post("/c/quotes", { title: "A", newJob: { name: "Shared job", poNumber: "PO-9" } });
    const again = await h.c.post("/c/quotes", { title: "B", jobId: first.body.job.id });
    expect(again.status).toBe(201);
    expect(again.body.job.id).toBe(first.body.job.id);
    const other = await h.asCustomer("gid://shopify/Customer/2001").post("/c/quotes", { title: "X", jobId: first.body.job.id });
    expect(other.status).toBe(422);
    expect(other.body.code).toBe("VALIDATION_FAILED");
  });

  it("GET /c/quotes lists my location's quotes with status/jobId/q filters and cursor paging", async () => {
    const q1 = await draftWith(h, [{ variantId: V_GOOD, qty: 1 }]);
    const q2 = await submitted(h);
    await h.c.post("/c/quotes", { title: "Needle in haystack", newJob: { name: "Barn", poNumber: "ZZ-123" } });

    const all = await h.c.get("/c/quotes");
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(3);
    expect(all.body.nextCursor).toBeNull();
    expect(all.body.items[0]).toHaveProperty("actions");

    expect((await h.c.get("/c/quotes?status=SUBMITTED")).body.items.map((i: any) => i.id)).toEqual([q2.id]);
    expect((await h.c.get(`/c/quotes?jobId=${q1.job.id}`)).body.items.map((i: any) => i.id)).toEqual([q1.id]);
    expect((await h.c.get("/c/quotes?q=needle")).body.items).toHaveLength(1);
    expect((await h.c.get("/c/quotes?q=zz-123")).body.items).toHaveLength(1);
    expect((await h.c.get("/c/quotes?q=Barn")).body.items).toHaveLength(1);
    expect((await h.c.get(`/c/quotes?q=${q2.displayNumber}`)).body.items.map((i: any) => i.id)).toEqual([q2.id]);

    const p1 = await h.c.get("/c/quotes?limit=2");
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await h.c.get(`/c/quotes?limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.nextCursor).toBeNull();
    expect(new Set([...p1.body.items, ...p2.body.items].map((i: any) => i.id)).size).toBe(3);
    expect((await h.c.get("/c/quotes?status=NOPE")).status).toBe(400);
  });

  it("GET /c/quotes/:id returns the quote, and a colleague at the same location can read it", async () => {
    const q = await draftWith(h);
    const r = await h.c.get(`/c/quotes/${q.id}`);
    expect(r.status).toBe(200);
    expect(r.body.lines).toHaveLength(1);
    const colleague = await h.asCustomer("gid://shopify/Customer/1002").get(`/c/quotes/${q.id}`);
    expect(colleague.status).toBe(200);
  });

  it("PATCH /c/quotes/:id edits header fields on a draft only (watchers stay editable while open)", async () => {
    const q = await draftWith(h);
    const r = await h.c.patch(`/c/quotes/${q.id}`, {
      title: "Renamed",
      poNumber: "PO-NEW",
      neededBy: "2026-05-05",
      notesToSales: "Need by Friday",
      shipTo: { name: "Dock", address1: "1 Dock Rd", city: "Chicago", province: "IL", zip: "60601", country: "US" },
      watchers: ["boss@example.test"],
      newJob: { name: "Another job" },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ title: "Renamed", poNumber: "PO-NEW", neededBy: "2026-05-05", notesToSales: "Need by Friday", watchers: ["boss@example.test"], job: { name: "Another job" } });
    expect(r.body.shipTo.city).toBe("Chicago");
    expect((await h.c.patch(`/c/quotes/${q.id}`, { shipTo: null, jobId: null })).body).toMatchObject({ shipTo: null, job: null });

    await h.c.post(`/c/quotes/${q.id}/submit`, {});
    const locked = await h.c.patch(`/c/quotes/${q.id}`, { title: "Too late" });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe("NOT_EDITABLE");
    const watchers = await h.c.patch(`/c/quotes/${q.id}`, { watchers: ["a@example.test", "b@example.test"] });
    expect(watchers.status).toBe(200);
    expect(watchers.body.watchers).toHaveLength(2);
    expect((await h.c.patch(`/c/quotes/${q.id}`, {})).status).toBe(400);
    expect((await h.c.patch(`/c/quotes/${q.id}`, { watchers: ["not-an-email"] })).status).toBe(400);
  });

  it("DELETE /c/quotes/:id soft-deletes a draft via transition DELETE and writes one event", async () => {
    const q = await draftWith(h);
    const r = await h.c.del(`/c/quotes/${q.id}`);
    expect(r.status).toBe(204);
    expect((await h.c.get(`/c/quotes/${q.id}`)).status).toBe(404);
    expect((await h.c.get("/c/quotes")).body.items).toHaveLength(0);
    const row = await h.prisma.quote.findUnique({ where: { id: q.id } });
    expect(row?.status).toBe("ARCHIVED");
    expect(row?.deletedAt).not.toBeNull();
    expect(await eventsOf(h, q.id, "DELETE")).toHaveLength(1);
    expect((await h.c.get("/c/active-quote")).body.quoteId).toBeNull();
  });

  it("DELETE refuses non-drafts with INVALID_TRANSITION", async () => {
    const q = await submitted(h);
    const r = await h.c.del(`/c/quotes/${q.id}`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("INVALID_TRANSITION");
  });

  describe("lines", () => {
    it("POST lines snapshots the buyer's contextual price and merges repeats; cost is stored but never returned", async () => {
      const q = await draftWith(h, []);
      const r = await h.c.post(`/c/quotes/${q.id}/lines`, { variantId: V_GOOD, qty: 3, lineNote: "blue" });
      expect(r.status).toBe(201);
      expect(r.body.lines[0]).toMatchObject({ variantId: V_GOOD, qty: 3, listPrice: "50.00", quotedPrice: "50.00", lineTotal: "150.00", lineNote: "blue", title: "Good Widget" });
      expect(r.body.total).toBe("150.00");
      expect(r.body.lineCount).toBe(1);
      expect(r.body.actions.canSubmit).toBe(true);
      const stored = await h.prisma.quoteLine.findFirstOrThrow({ where: { quoteId: q.id } });
      expect(stored.cost?.toString()).toBe("20");

      const merged = await h.c.post(`/c/quotes/${q.id}/lines`, { variantId: V_GOOD, qty: 2 });
      expect(merged.body.lines).toHaveLength(1);
      expect(merged.body.lines[0].qty).toBe(5);
      const nocost = await h.c.post(`/c/quotes/${q.id}/lines`, { variantId: V_NOCOST, qty: 1 });
      expect(nocost.body.lines).toHaveLength(2);
      expect((await h.prisma.quoteLine.findFirstOrThrow({ where: { quoteId: q.id, variantId: V_NOCOST } })).cost).toBeNull();
    });

    it("price is a snapshot: later catalog changes do not move the quote", async () => {
      const q = await draftWith(h, [{ variantId: V_GOOD, qty: 1 }]);
      h.shopify.addVariant({ variantId: V_GOOD, price: "75.00", unitCost: "30.00", title: "Good Widget" });
      expect((await h.c.get(`/c/quotes/${q.id}`)).body.lines[0].quotedPrice).toBe("50.00");
      const second = await h.c.post(`/c/quotes/${q.id}/lines`, { variantId: V_NOCOST, qty: 1 });
      expect(second.body.lines.find((l: any) => l.variantId === V_GOOD).quotedPrice).toBe("50.00");
    });

    it("uses the price for the buyer's own company location", async () => {
      h.shopify.addVariant({ variantId: V_GOOD, price: "42.00", unitCost: "20.00", title: "Good Widget" }, LOC1);
      const q = await draftWith(h, [{ variantId: V_GOOD, qty: 1 }]);
      expect(q.lines[0].quotedPrice).toBe("42.00");
    });

    it("rejects an unknown variant and bad quantities", async () => {
      const q = await draftWith(h, []);
      const unknown = await h.c.post(`/c/quotes/${q.id}/lines`, { variantId: "gid://shopify/ProductVariant/404", qty: 1 });
      expect(unknown.status).toBe(422);
      expect(unknown.body.code).toBe("VALIDATION_FAILED");
      expect((await h.c.post(`/c/quotes/${q.id}/lines`, { variantId: V_GOOD, qty: 0 })).status).toBe(400);
      expect((await h.c.post(`/c/quotes/${q.id}/lines`, { variantId: V_GOOD, qty: 1.5 })).status).toBe(400);
    });

    it("PATCH and DELETE a line (DRAFT only)", async () => {
      const q = await draftWith(h, [{ variantId: V_GOOD, qty: 2 }, { variantId: V_NOCOST, qty: 1 }]);
      const [l1, l2] = q.lines;
      const patched = await h.c.patch(`/c/quotes/${q.id}/lines/${l1.id}`, { qty: 10, lineNote: "rush" });
      expect(patched.status).toBe(200);
      expect(patched.body.lines.find((l: any) => l.id === l1.id)).toMatchObject({ qty: 10, lineNote: "rush", lineTotal: "500.00" });
      expect(patched.body.total).toBe("510.00");
      expect((await h.c.patch(`/c/quotes/${q.id}/lines/${l1.id}`, {})).status).toBe(400);
      expect((await h.c.patch(`/c/quotes/${q.id}/lines/nope`, { qty: 1 })).status).toBe(404);

      const removed = await h.c.del(`/c/quotes/${q.id}/lines/${l2.id}`);
      expect(removed.status).toBe(200);
      expect(removed.body.lines).toHaveLength(1);
      expect(removed.body.total).toBe("500.00");
      expect((await h.c.del(`/c/quotes/${q.id}/lines/${l2.id}`)).status).toBe(404);
    });

    it("all line edits are refused once submitted (NOT_EDITABLE)", async () => {
      const q = await submitted(h);
      const line = q.lines[0];
      for (const r of [
        await h.c.post(`/c/quotes/${q.id}/lines`, { variantId: V_GOOD, qty: 1 }),
        await h.c.patch(`/c/quotes/${q.id}/lines/${line.id}`, { qty: 9 }),
        await h.c.del(`/c/quotes/${q.id}/lines/${line.id}`),
      ]) {
        expect(r.status).toBe(409);
        expect(r.body.code).toBe("NOT_EDITABLE");
      }
    });
  });

  describe("from-cart", () => {
    it("creates a new draft from cart lines", async () => {
      const r = await h.c.post("/c/quotes/from-cart", {
        cartLines: [{ variantId: V_GOOD, qty: 2 }, { variantId: V_COSTLY, qty: 1 }],
        target: { mode: "new", title: "From my cart", newJob: { name: "Cart job", poNumber: "PO-C" }, neededBy: "2026-06-01", notesToSales: "Please rush" },
        emptyCart: true,
      });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ status: "DRAFT", title: "From my cart", lineCount: 2, total: "200.00", notesToSales: "Please rush", neededBy: "2026-06-01" });
      expect(await eventsOf(h, r.body.id, "FROM_CART")).toHaveLength(1);
    });

    it("adds to an existing draft and merges quantities", async () => {
      const q = await draftWith(h, [{ variantId: V_GOOD, qty: 1 }]);
      const r = await h.c.post("/c/quotes/from-cart", { cartLines: [{ variantId: V_GOOD, qty: 4 }, { variantId: V_NOCOST, qty: 2 }], target: { mode: "existing", quoteId: q.id } });
      expect(r.status).toBe(201);
      expect(r.body.id).toBe(q.id);
      expect(r.body.lines.find((l: any) => l.variantId === V_GOOD).qty).toBe(5);
      expect(r.body.lineCount).toBe(2);
    });

    it("submit:true moves the new quote straight to SUBMITTED", async () => {
      const r = await h.c.post("/c/quotes/from-cart", { cartLines: [{ variantId: V_GOOD, qty: 1 }], target: { mode: "new", title: "Go" }, submit: true });
      expect(r.status).toBe(201);
      expect(r.body.status).toBe("SUBMITTED");
      expect(await eventsOf(h, r.body.id, "SUBMIT")).toHaveLength(1);
    });

    it("refuses a non-draft target and an empty cart", async () => {
      const q = await submitted(h);
      const r = await h.c.post("/c/quotes/from-cart", { cartLines: [{ variantId: V_GOOD, qty: 1 }], target: { mode: "existing", quoteId: q.id } });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("NOT_EDITABLE");
      expect((await h.c.post("/c/quotes/from-cart", { cartLines: [], target: { mode: "new", title: "x" } })).status).toBe(400);
    });
  });

  describe("transitions", () => {
    it("submit: DRAFT -> SUBMITTED with one event; header overrides applied; empty drafts refused", async () => {
      const empty = await draftWith(h, []);
      const refused = await h.c.post(`/c/quotes/${empty.id}/submit`, {});
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe("VALIDATION_FAILED");
      expect((await h.prisma.quote.findUnique({ where: { id: empty.id } }))?.status).toBe("DRAFT");

      const q = await draftWith(h);
      const r = await h.c.post(`/c/quotes/${q.id}/submit`, { notesToSales: "ASAP", neededBy: "2026-04-10", poNumber: "PO-S" });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: "SUBMITTED", waitingOn: "sales", notesToSales: "ASAP", neededBy: "2026-04-10", poNumber: "PO-S" });
      expect(r.body.actions).toMatchObject({ canEditLines: false, canWithdraw: true, canSubmit: false, canDelete: false });
      const ev = await eventsOf(h, q.id, "SUBMIT");
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ actorType: "CUSTOMER", actorId: CUSTOMER_A });
      expect(ev[0]!.payload).toMatchObject({ from: "DRAFT", to: "SUBMITTED" });
      const again = await h.c.post(`/c/quotes/${q.id}/submit`, {});
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("INVALID_TRANSITION");
    });

    it("withdraw: SUBMITTED -> DRAFT, lines editable again", async () => {
      const q = await submitted(h);
      const r = await h.c.post(`/c/quotes/${q.id}/withdraw`);
      expect(r.status).toBe(200);
      expect(r.body.status).toBe("DRAFT");
      expect(r.body.actions.canEditLines).toBe(true);
      expect(await eventsOf(h, q.id, "WITHDRAW")).toHaveLength(1);
      expect((await h.c.post(`/c/quotes/${q.id}/withdraw`)).status).toBe(409);
    });

    it("accept: QUOTE_READY -> ACCEPTED for the current version; stale version -> 409 VERSION_MISMATCH", async () => {
      const q = await sent(h);
      expect(q.status).toBe("QUOTE_READY");
      expect(q.actions).toMatchObject({ canAccept: true, canRequestChanges: true, canBuy: false });
      const stale = await h.c.post(`/c/quotes/${q.id}/accept`, { versionNo: 0 });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ code: "VERSION_MISMATCH", details: { currentVersion: 1 } });
      expect((await h.prisma.quote.findUnique({ where: { id: q.id } }))?.status).toBe("QUOTE_READY");

      const ok = await h.c.post(`/c/quotes/${q.id}/accept`, { versionNo: 1 });
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe("ACCEPTED");
      expect(ok.body.actions).toMatchObject({ canBuy: true, canReopen: true, canAccept: false });
      expect(await eventsOf(h, q.id, "ACCEPT")).toHaveLength(1);
    });

    it("accept without versionNo works, and an expired quote is expired (persisted) instead of accepted", async () => {
      const q = await sent(h);
      h.clock.now = new Date(h.clock.now.getTime() + 15 * 24 * 3600 * 1000);
      const r = await h.c.post(`/c/quotes/${q.id}/accept`, {});
      expect(r.status).toBe(409);
      expect(r.body.details).toMatchObject({ status: "EXPIRED" });
      expect((await h.prisma.quote.findUnique({ where: { id: q.id } }))?.status).toBe("EXPIRED");
      expect(await eventsOf(h, q.id, "EXPIRE")).toHaveLength(1);

      h.clock.now = new Date("2026-03-02T15:00:00.000Z");
      const q2 = await sent(h);
      expect((await h.c.post(`/c/quotes/${q2.id}/accept`, {})).status).toBe(200);
    });

    it("request-changes: QUOTE_READY -> CHANGES_REQUESTED, message recorded in the conversation, one event", async () => {
      const q = await sent(h);
      const r = await h.c.post(`/c/quotes/${q.id}/request-changes`, { message: "Can you do 48 inch?" });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe("CHANGES_REQUESTED");
      expect(r.body.waitingOn).toBe("sales");
      expect(r.body.messages.map((m: any) => m.body)).toContain("Can you do 48 inch?");
      const ev = await eventsOf(h, q.id, "REQUEST_CHANGES");
      expect(ev).toHaveLength(1);
      expect(ev[0]!.payload).toMatchObject({ message: "Can you do 48 inch?" });
      expect(await eventsOf(h, q.id, "NEW_MESSAGE")).toHaveLength(0);
      expect((await h.c.post(`/c/quotes/${q.id}/request-changes`, {})).status).toBe(400);
      expect((await h.c.post(`/c/quotes/${q.id}/request-changes`, { message: "again" })).status).toBe(409);
    });

    it("decline: any open status -> DECLINED with optional reason", async () => {
      const q = await sent(h);
      const r = await h.c.post(`/c/quotes/${q.id}/decline`, { reason: "Went with another vendor" });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe("DECLINED");
      expect(r.body.waitingOn).toBe("none");
      expect(r.body.messages.map((m: any) => m.body)).toContain("Went with another vendor");
      expect((await eventsOf(h, q.id, "DECLINE"))[0]!.payload).toMatchObject({ reason: "Went with another vendor" });
      expect((await h.c.post(`/c/quotes/${q.id}/decline`, {})).status).toBe(409);

      const plain = await submitted(h);
      expect((await h.c.post(`/c/quotes/${plain.id}/decline`)).body.status).toBe("DECLINED");
    });

    it("reopen: ACCEPTED -> IN_REVIEW (customer), only from ACCEPTED", async () => {
      const q = await sent(h);
      expect((await h.c.post(`/c/quotes/${q.id}/reopen`)).status).toBe(409);
      await h.c.post(`/c/quotes/${q.id}/accept`, {});
      const r = await h.c.post(`/c/quotes/${q.id}/reopen`);
      expect(r.status).toBe(200);
      expect(r.body.status).toBe("IN_REVIEW");
      expect(await eventsOf(h, q.id, "REOPEN")).toHaveLength(1);
    });

    it("duplicate: copies any quote to a new DRAFT with re-snapshotted prices", async () => {
      const q = await sent(h, [{ variantId: V_GOOD, qty: 3 }], { [V_GOOD]: "45.00" });
      h.shopify.addVariant({ variantId: V_GOOD, price: "55.00", unitCost: "20.00", title: "Good Widget" });
      const r = await h.c.post(`/c/quotes/${q.id}/duplicate`);
      expect(r.status).toBe(201);
      expect(r.body.id).not.toBe(q.id);
      expect(r.body).toMatchObject({ status: "DRAFT", title: "Test quote (copy)", lineCount: 1, job: { name: "Job One" } });
      expect(r.body.lines[0]).toMatchObject({ qty: 3, listPrice: "55.00", quotedPrice: "55.00" });
      expect(r.body.number).toBeGreaterThan(q.number);
      expect((await h.c.get("/c/active-quote")).body.quoteId).toBe(r.body.id);
      expect(await eventsOf(h, r.body.id, "DUPLICATED_FROM")).toHaveLength(1);
    });
  });

  describe("conversation", () => {
    it("POST/GET messages: customer posts, only customer-visible messages come back, paging works", async () => {
      const q = await submitted(h);
      const a = await h.c.post(`/c/quotes/${q.id}/messages`, { body: "Hello sales" });
      expect(a.status).toBe(201);
      expect(a.body).toMatchObject({ authorType: "CUSTOMER", authorName: "Dana Dealer", body: "Hello sales", channel: "WEB", attachments: [] });
      await h.c.post(`/c/quotes/${q.id}/messages`, { body: "Second" });
      await h.c.post(`/c/quotes/${q.id}/messages`, { body: "Third" });
      const list = await h.c.get(`/c/quotes/${q.id}/messages?limit=2`);
      expect(list.body.items.map((m: any) => m.body)).toEqual(["Hello sales", "Second"]);
      const next = await h.c.get(`/c/quotes/${q.id}/messages?limit=2&cursor=${list.body.nextCursor}`);
      expect(next.body.items.map((m: any) => m.body)).toEqual(["Third"]);
      expect(next.body.nextCursor).toBeNull();
      const ev = await eventsOf(h, q.id, "NEW_MESSAGE");
      expect(ev).toHaveLength(3);
      expect((await h.c.post(`/c/quotes/${q.id}/messages`, { body: "" })).status).toBe(400);
    });

    it("refuses chat on a draft and attachments that are not from our upload endpoint", async () => {
      const d = await draftWith(h);
      const r = await h.c.post(`/c/quotes/${d.id}/messages`, { body: "hi" });
      expect(r.status).toBe(409);
      const q = await submitted(h);
      const bad = await h.c.post(`/c/quotes/${q.id}/messages`, { body: "see", attachments: [{ url: "https://evil.example/x.pdf", name: "x.pdf", size: 10, mime: "application/pdf" }] });
      expect(bad.status).toBe(422);
    });

    it("POST attachments/upload-url returns a signed upload target that is then accepted on a message", async () => {
      const q = await submitted(h);
      const up = await h.c.post(`/c/quotes/${q.id}/attachments/upload-url`, { name: "plan drawing.pdf", size: 1234, mime: "application/pdf" });
      expect(up.status).toBe(200);
      expect(up.body.uploadUrl).toContain("uploads.fake.test");
      expect(up.body.fileUrl).toContain(`quotes/${q.id}/`);
      expect(new Date(up.body.expiresAt).getTime()).toBeGreaterThan(h.clock.now.getTime());
      const msg = await h.c.post(`/c/quotes/${q.id}/messages`, { body: "plan attached", attachments: [{ url: up.body.fileUrl, name: "plan drawing.pdf", size: 1234, mime: "application/pdf" }] });
      expect(msg.status).toBe(201);
      expect(msg.body.attachments[0].name).toBe("plan drawing.pdf");
      expect((await h.c.post(`/c/quotes/${q.id}/attachments/upload-url`, { name: "big.bin", size: 99999999, mime: "x/y" })).status).toBe(400);
    });
  });

  describe("notification prefs", () => {
    it("GET returns defaults, PUT stores the matrix and consent, GET reads it back", async () => {
      const def = await h.c.get("/c/notification-prefs");
      expect(def.status).toBe(200);
      expect(def.body.events.QUOTE_READY).toEqual({ email: true, sms: false });
      expect(def.body).toMatchObject({ smsOptIn: false, email: "dana@example.test", timezone: "America/New_York" });

      const put = await h.c.put("/c/notification-prefs", {
        events: { QUOTE_READY: { email: true, sms: true }, NEW_MESSAGE: { email: false, sms: true }, ORDERED: { email: true, sms: false } },
        email: "dana.alt@example.test",
        phone: "+13125550123",
        smsOptIn: true,
        smsConsentText: "I agree to receive texts from DSG about my quotes.",
        quietStart: "19:00",
        quietEnd: "07:00",
        timezone: "America/Chicago",
        watchers: ["boss@example.test"],
      });
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({
        smsOptIn: true,
        smsConsentText: "I agree to receive texts from DSG about my quotes.",
        phone: "+13125550123",
        quietStart: "19:00",
        timezone: "America/Chicago",
        email: "dana.alt@example.test",
        watchers: ["boss@example.test"],
      });
      expect(put.body.smsOptInAt).toBe(h.clock.now.toISOString());
      expect(put.body.events.NEW_MESSAGE).toEqual({ email: false, sms: true });

      // Re-saving keeps the ORIGINAL consent timestamp and wording.
      h.clock.now = new Date("2026-03-09T10:00:00.000Z");
      const again = await h.c.put("/c/notification-prefs", { ...put.body, smsConsentText: "Different wording", smsOptInAt: undefined });
      expect(again.body.smsOptInAt).toBe("2026-03-02T15:00:00.000Z");
      expect(again.body.smsConsentText).toBe("I agree to receive texts from DSG about my quotes.");

      // Opting out clears consent and turns every SMS flag off.
      const out = await h.c.put("/c/notification-prefs", { events: { QUOTE_READY: { email: true, sms: false } }, email: "dana.alt@example.test", smsOptIn: false });
      expect(out.body).toMatchObject({ smsOptIn: false, smsOptInAt: null });
    });

    it("rejects SMS without opt-in, without a valid phone, or without consent text", async () => {
      const base = { events: { QUOTE_READY: { email: true, sms: true } }, email: "d@example.test" };
      expect((await h.c.put("/c/notification-prefs", base)).status).toBe(422);
      expect((await h.c.put("/c/notification-prefs", { ...base, smsOptIn: true, smsConsentText: "ok", phone: "312-555" })).status).toBe(422);
      expect((await h.c.put("/c/notification-prefs", { ...base, smsOptIn: true, phone: "+13125550123" })).status).toBe(422);
      expect((await h.c.put("/c/notification-prefs", { ...base, email: "nope" })).status).toBe(400);
      expect((await h.c.get("/c/notification-prefs")).body.smsOptIn).toBe(false);
    });
  });

  describe("active quote", () => {
    it("GET/PUT selects a draft, clears with null, and refuses non-drafts and foreign quotes", async () => {
      const a = await draftWith(h);
      const b = await draftWith(h);
      expect((await h.c.get("/c/active-quote")).body.quoteId).toBe(b.id);
      const put = await h.c.put("/c/active-quote", { quoteId: a.id });
      expect(put.body).toMatchObject({ quoteId: a.id, lineCount: 1, title: "Test quote" });
      expect((await h.c.put("/c/active-quote", { quoteId: null })).body.quoteId).toBeNull();
      expect((await h.c.put("/c/active-quote", { quoteId: "nope" })).status).toBe(404);
      await h.c.post(`/c/quotes/${a.id}/submit`, {});
      expect((await h.c.put("/c/active-quote", { quoteId: a.id })).status).toBe(409);
      expect((await h.c.put("/c/active-quote", {})).status).toBe(400);
    });

    it("a submitted quote stops being the active target", async () => {
      const a = await draftWith(h);
      await h.c.post(`/c/quotes/${a.id}/submit`, {});
      expect((await h.c.get("/c/active-quote")).body.quoteId).toBeNull();
    });
  });

  it("works through the app proxy flavour too (HMAC-signed, /proxy prefix)", async () => {
    const created = await h.proxy.post("/c/quotes", { title: "Via proxy" });
    expect(created.status).toBe(201);
    const list = await h.proxy.get("/c/quotes?status=DRAFT");
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: any) => i.id)).toEqual([created.body.id]);
    expect(CUSTOMER_A).toContain("1001");
  });
});
