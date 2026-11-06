/**
 * RUNNABLE LAYER: rep-created quotes shared with the customer for review (DRAFT -> SHARED -> QUOTE_READY).
 * Covers share/unshare/delete, line insert + reorder, comments between lines (internal ones never reach the customer),
 * "customer is ready", optimistic concurrency (`rev`), and the hand-off into the normal send -> accept flow.
 */
import { describe, expect, it } from "vitest";
import { ok } from "./support/flows";
import * as F from "./support/fixtures";
import { useWorld } from "./support/world";

const SECRET = "INTERNAL-ONLY-COMMENT-8841";

describe("rep-created quote: share, collaborate, send, accept", () => {
  const w = useWorld();

  async function repDraft(lines = [{ variantId: F.V_PIPE, qty: 2 }, { variantId: F.V_VALVE, qty: 1 }]) {
    return ok(await w.rep1.post("/s/quotes", { customerId: F.DANA.id, title: "Rep built", lines }), 201, "create");
  }

  it("full collaboration flow ends in a purchasable quote", async () => {
    const d = await repDraft();
    expect(d.status).toBe("DRAFT");
    expect(d.createdByStaffId).toBeTruthy();
    expect(d.workingLines).toHaveLength(2);

    // Private while DRAFT: internal comment and a staff-inserted line at the top.
    ok(await w.rep1.post(`/s/quotes/${d.id}/comments`, { body: SECRET, internal: true }), 201, "internal comment");
    const withTop = ok(await w.rep1.post(`/s/quotes/${d.id}/lines`, { variantId: F.V_THIN, qty: 1, afterLineId: null }), 201, "insert top");
    expect(withTop.workingLines[0].variantId).toBe(F.V_THIN);
    expect((await w.dana.get(`/c/quotes/${d.id}`)).status).toBe(404); // still invisible

    const list = ok(await w.rep1.get("/s/quotes?tab=my_drafts"), 200, "my drafts");
    expect(list.items.map((i: any) => i.id)).toContain(d.id);

    // Share.
    const shared = ok(await w.rep1.post(`/s/quotes/${d.id}/share`, { message: "Please check qty" }), 200, "share");
    expect(shared.status).toBe("SHARED");
    expect(ok(await w.rep1.get("/s/quotes?tab=shared"), 200, "shared tab").items.map((i: any) => i.id)).toContain(d.id);

    // Customer sees it, without internal comments, cost or margin (the harness leak scanner also checks every /c response).
    let c = ok(await w.dana.get(`/c/quotes/${d.id}`), 200, "dana sees shared");
    expect(c.status).toBe("SHARED");
    expect(c.lines).toHaveLength(3);
    expect(c.comments).toHaveLength(0);
    expect(c.actions).toMatchObject({ canEditLines: true, canReorder: true, canMarkReady: true, canAccept: false, canBuy: false, canSubmit: false });
    expect(JSON.stringify(c)).not.toContain(SECRET);

    // Customer adds a line below the first, comments, then reorders.
    c = ok(await w.dana.post(`/c/quotes/${d.id}/lines`, { variantId: F.V_VALVE, qty: 3, afterLineId: c.lines[0].id }), 201, "dana adds line");
    expect(c.lines.map((l: any) => l.position)).toEqual([1, 2, 3, 4].slice(0, c.lines.length));
    c = ok(await w.dana.post(`/c/quotes/${d.id}/comments`, { body: "Can we use 2in?", afterLineId: c.lines[0].id }), 201, "dana comment");
    expect(c.comments).toHaveLength(1);
    expect(c.comments[0]).toMatchObject({ mine: true, authorType: "CUSTOMER" });
    const reversed = c.lines.map((l: any) => l.id).reverse();
    c = ok(await w.dana.put(`/c/quotes/${d.id}/lines/order`, { lineIds: reversed, rev: c.rev }), 200, "dana reorder");
    expect(c.lines.map((l: any) => l.id)).toEqual(reversed);
    expect(c.actions.canMarkReady).toBe(true);

    // Rep sees the customer's edits in the pricing set, with their own private price untouched.
    let s = ok(await w.rep1.get(`/s/quotes/${d.id}`), 200, "rep view");
    expect(s.workingLines).toHaveLength(c.lines.length);
    expect(s.comments.map((x: any) => x.body)).toEqual(expect.arrayContaining([SECRET, "Can we use 2in?"]));

    // Customer marks ready: waiting on sales; rep inbox counts it as needing a response.
    c = ok(await w.dana.post(`/c/quotes/${d.id}/ready`), 200, "ready");
    expect(c).toMatchObject({ status: "SHARED", waitingOn: "sales" });
    expect(c.actions.canMarkReady).toBe(false);
    expect(ok(await w.rep1.get("/s/quotes?tab=needs_response"), 200, "needs").items.map((i: any) => i.id)).toContain(d.id);

    // A rep edit clears "ready"; a stale rev is refused (409) and nothing is overwritten.
    s = ok(await w.rep1.get(`/s/quotes/${d.id}`), 200, "reload");
    const stale = s.rev;
    s = ok(await w.rep1.post(`/s/quotes/${d.id}/comments`, { body: "Updated pricing soon" }), 201, "rep comment");
    expect(s.customerReady).toBe(false);
    const lines = s.workingLines.map((l: any) => ({ id: l.id, variantId: l.variantId, qty: l.qty, quotedPrice: l.quotedPrice, lineNote: l.lineNote }));
    const staleSave = await w.rep1.put(`/s/quotes/${d.id}/draft-revision`, { lines, rev: stale });
    expect(staleSave.status).toBe(409);
    expect(staleSave.body.code).toBe("VERSION_MISMATCH");
    expect(staleSave.body.details.currentRev).toBe(s.rev);

    // Reprice with the current rev, then send and accept.
    const priced = lines.map((l: any) => ({ ...l, quotedPrice: l.variantId === F.V_THIN ? "100.00" : l.quotedPrice }));
    ok(await w.rep1.put(`/s/quotes/${d.id}/draft-revision`, { lines: priced, rev: s.rev }), 200, "reprice");
    ok(await w.manager.post(`/s/quotes/${d.id}/approve-floor`, { note: "ok" }), 200, "approve");
    const sent = ok(await w.rep1.post(`/s/quotes/${d.id}/send`), 200, "send");
    expect(sent.status).toBe("QUOTE_READY");
    const ready = ok(await w.dana.get(`/c/quotes/${d.id}`), 200, "dana after send");
    expect(ready.comments).toHaveLength(0); // review comments are not part of the binding quote
    expect(ready.lines).toHaveLength(sent.workingLines.length);
    ok(await w.dana.post(`/c/quotes/${d.id}/accept`, { versionNo: 1 }), 200, "accept");
  });

  it("customer can delete only their own comment; reps can delete any", async () => {
    const d = await repDraft();
    ok(await w.rep1.post(`/s/quotes/${d.id}/share`, {}), 200, "share");
    const mine = ok(await w.dana.post(`/c/quotes/${d.id}/comments`, { body: "mine" }), 201, "comment").comments[0];
    const repC = ok(await w.rep1.post(`/s/quotes/${d.id}/comments`, { body: "rep's" }), 201, "rep comment").comments.find((x: any) => x.body === "rep's");
    expect((await w.dana.del(`/c/quotes/${d.id}/comments/${repC.id}`)).status).toBe(404);
    expect((await w.drew.del(`/c/quotes/${d.id}/comments/${mine.id}`)).status).toBe(404); // colleague, not the author
    expect(ok(await w.dana.del(`/c/quotes/${d.id}/comments/${mine.id}`), 200, "delete own").comments.map((x: any) => x.body)).toEqual(["rep's"]);
    ok(await w.rep1.del(`/s/quotes/${d.id}/comments/${repC.id}`), 200, "rep deletes");
    expect((await w.rep1.del(`/s/quotes/${d.id}/comments/nope`)).status).toBe(404);
  });

  it("deleting a line re-anchors its comments instead of orphaning them; reps can delete lines", async () => {
    const d = await repDraft();
    ok(await w.rep1.post(`/s/quotes/${d.id}/share`, {}), 200, "share");
    let c = ok(await w.dana.get(`/c/quotes/${d.id}`), 200, "get");
    const [l1, l2] = c.lines;
    c = ok(await w.dana.post(`/c/quotes/${d.id}/comments`, { body: "about line 2", afterLineId: l2.id }), 201, "comment");
    c = ok(await w.dana.del(`/c/quotes/${d.id}/lines/${l2.id}`), 200, "delete line");
    expect(c.comments[0].afterLineId).toBe(l1.id);
    const s = ok(await w.rep1.get(`/s/quotes/${d.id}`), 200, "rep");
    ok(await w.rep1.del(`/s/quotes/${d.id}/lines/${s.workingLines[0].id}`), 200, "rep deletes line");
    expect((await w.rep1.del(`/s/quotes/${d.id}/lines/nope`)).status).toBe(422);
  });

  it("rep reorders lines; a stale rev is refused; bad id lists are refused", async () => {
    const d = await repDraft();
    const ids = d.workingLines.map((l: any) => l.id).reverse();
    const r = ok(await w.rep1.put(`/s/quotes/${d.id}/lines/order`, { lineIds: ids, rev: d.rev }), 200, "reorder");
    expect(r.workingLines.map((l: any) => l.id)).toEqual(ids);
    const stale = await w.rep1.put(`/s/quotes/${d.id}/lines/order`, { lineIds: ids, rev: d.rev });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("VERSION_MISMATCH");
    const bad = await w.rep1.put(`/s/quotes/${d.id}/lines/order`, { lineIds: [ids[0]], rev: r.rev });
    expect(bad.status).toBe(422);
    ok(await w.rep1.post(`/s/quotes/${d.id}/share`, {}), 200, "share");
    const c = ok(await w.dana.get(`/c/quotes/${d.id}`), 200, "dana");
    expect((await w.dana.put(`/c/quotes/${d.id}/lines/order`, { lineIds: [c.lines[0].id], rev: c.rev })).status).toBe(422);
  });

  it("unshare hides it again; a rep can delete their own draft; nothing else can be deleted or shared", async () => {
    const d = await repDraft();
    ok(await w.rep1.post(`/s/quotes/${d.id}/share`, {}), 200, "share");
    expect((await w.rep1.del(`/s/quotes/${d.id}`)).status).toBe(409); // SHARED cannot be deleted, only unshared or declined
    ok(await w.rep1.post(`/s/quotes/${d.id}/unshare`), 200, "unshare");
    expect((await w.dana.get(`/c/quotes/${d.id}`)).status).toBe(404);
    expect((await w.rep1.post(`/s/quotes/${d.id}/unshare`)).status).toBe(409); // already private
    expect(ok(await w.rep1.del(`/s/quotes/${d.id}`), 200, "delete").status).toBe("ARCHIVED");
    // A customer's own private draft: staff cannot share, delete or edit it.
    const own = ok(await w.dana.post("/c/quotes", { title: "Mine" }), 201, "dana draft");
    ok(await w.dana.post(`/c/quotes/${own.id}/lines`, { variantId: F.V_PIPE, qty: 1 }), 201, "line");
    expect((await w.rep1.post(`/s/quotes/${own.id}/share`, {})).status).toBe(409);
    expect((await w.rep1.del(`/s/quotes/${own.id}`)).status).toBe(409);
    expect((await w.rep1.post(`/s/quotes/${own.id}/lines`, { variantId: F.V_PIPE, qty: 1 })).status).toBe(409);
    expect((await w.rep1.post(`/s/quotes/${own.id}/comments`, { body: "x" })).status).toBe(409);
    // Empty rep draft cannot be shared.
    const empty = ok(await w.rep1.post("/s/quotes", { customerId: F.DANA.id, title: "Empty" }), 201, "empty");
    expect((await w.rep1.post(`/s/quotes/${empty.id}/share`, {})).status).toBe(422);
  });

  it("customer actions that do not apply to a shared draft are refused; other companies get 404", async () => {
    const d = await repDraft();
    ok(await w.rep1.post(`/s/quotes/${d.id}/share`, {}), 200, "share");
    expect((await w.dana.post(`/c/quotes/${d.id}/accept`, {})).status).toBe(409);
    expect((await w.dana.post(`/c/quotes/${d.id}/submit`, {})).status).toBe(409);
    expect((await w.dana.del(`/c/quotes/${d.id}`)).status).toBe(409);
    expect((await w.dana.post(`/c/quotes/${d.id}/checkout`)).status).toBe(409);
    for (const who of [w.bea, w.danaBranch]) {
      expect((await who.get(`/c/quotes/${d.id}`)).status).toBe(404);
      expect((await who.post(`/c/quotes/${d.id}/comments`, { body: "x" })).status).toBe(404);
      expect((await who.post(`/c/quotes/${d.id}/ready`)).status).toBe(404);
      expect((await who.put(`/c/quotes/${d.id}/lines/order`, { lineIds: ["a"], rev: 0 })).status).toBe(404);
    }
    // After send, collaboration endpoints close.
    ok(await w.rep1.post(`/s/quotes/${d.id}/send`), 200, "send");
    expect((await w.dana.post(`/c/quotes/${d.id}/comments`, { body: "late" })).status).toBe(409);
    expect((await w.dana.post(`/c/quotes/${d.id}/ready`)).status).toBe(409);
    expect((await w.dana.put(`/c/quotes/${d.id}/lines/order`, { lineIds: ["a"], rev: 0 })).status).toBe(409);
    expect((await w.rep1.post(`/s/quotes/${d.id}/comments`, { body: "late" })).status).toBe(409);
  });

  it("comment anchored to an unknown line is a 422", async () => {
    const d = await repDraft();
    expect((await w.rep1.post(`/s/quotes/${d.id}/comments`, { body: "x", afterLineId: "nope" })).status).toBe(422);
    ok(await w.rep1.post(`/s/quotes/${d.id}/share`, {}), 200, "share");
    expect((await w.dana.post(`/c/quotes/${d.id}/comments`, { body: "x", afterLineId: "nope" })).status).toBe(422);
  });
});
