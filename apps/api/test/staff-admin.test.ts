import { describe, expect, it } from "vitest";
import { STAFF_MANAGER, STAFF_REP, ensureStaff, useHarness } from "./helpers";

/** /s/me, /s/staff, /s/teams, /s/settings, /s/saved-replies, /s/customers (contract 0.2.0 API-1..API-12). */
describe("staff admin routes", () => {
  const h = useHarness();
  const mgr = () => h.asStaff(STAFF_MANAGER);
  async function people() {
    const rep = await ensureStaff(h, STAFF_REP, { name: "Rita Rep" });
    const manager = await ensureStaff(h, STAFF_MANAGER, { name: "Morgan Mgr", isManager: true });
    return { rep, manager };
  }

  it("GET /s/me reports role, effective floor and capabilities", async () => {
    const { rep, manager } = await people();
    expect((await h.s.get("/s/me")).body).toMatchObject({ id: rep.id, role: "rep", priceFloorPct: null, effectivePriceFloorPct: 15, canApproveFloor: false, canEditSettings: false });
    expect((await mgr().get("/s/me")).body).toMatchObject({ id: manager.id, role: "manager", canApproveFloor: true, canEditSettings: true });
    await mgr().put(`/s/staff/${rep.id}`, { priceFloorPct: 22.5 });
    expect((await h.s.get("/s/me")).body).toMatchObject({ priceFloorPct: 22.5, effectivePriceFloorPct: 22.5 });
    expect((await h.raw({ method: "GET", url: "/s/me" })).status).toBe(401);
  });

  it("GET /s/staff lists members, filters by active; PUT /s/staff/:id updates role, teams, floor, active", async () => {
    const { rep, manager } = await people();
    const team = (await mgr().post("/s/teams", { name: "Doors" })).body;
    const all = await h.s.get("/s/staff");
    expect(all.status).toBe(200);
    expect(all.body.items.map((i: any) => i.id).sort()).toEqual([rep.id, manager.id].sort());

    const up = await mgr().put(`/s/staff/${rep.id}`, { role: "manager", teamIds: [team.id], priceFloorPct: 10, active: true });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ id: rep.id, role: "manager", teamIds: [team.id], priceFloorPct: 10, active: true });
    expect((await mgr().put(`/s/staff/${rep.id}`, { priceFloorPct: null })).body.priceFloorPct).toBeNull();
    await mgr().put(`/s/staff/${rep.id}`, { active: false });
    expect((await mgr().get("/s/staff?active=false")).body.items.map((i: any) => i.id)).toEqual([rep.id]);
    expect((await mgr().get("/s/staff?active=true")).body.items.map((i: any) => i.id)).toEqual([manager.id]);
    // a deactivated member is locked out
    expect((await h.s.get("/s/me")).status).toBe(403);
  });

  it("PUT /s/staff/:id errors: rep 403, unknown 404, bad body 400, unknown team 422, last manager 400, admin role needs admin", async () => {
    const { rep, manager } = await people();
    expect((await h.s.put(`/s/staff/${rep.id}`, { active: false })).status).toBe(403);
    expect((await mgr().put("/s/staff/nope", { active: false })).status).toBe(404);
    expect((await mgr().put(`/s/staff/${rep.id}`, {})).status).toBe(400);
    expect((await mgr().put(`/s/staff/${rep.id}`, { role: "owner" })).status).toBe(400);
    expect((await mgr().put(`/s/staff/${rep.id}`, { priceFloorPct: 101 })).status).toBe(400);
    expect((await mgr().put(`/s/staff/${rep.id}`, { teamIds: ["ghost"] })).status).toBe(422);
    const last = await mgr().put(`/s/staff/${manager.id}`, { role: "rep" });
    expect(last.status).toBe(400);
    expect((await mgr().put(`/s/staff/${rep.id}`, { role: "admin" })).status).toBe(403);
    await ensureStaff(h, "5003", { role: "admin" });
    expect((await h.asStaff("5003").put(`/s/staff/${rep.id}`, { role: "admin" })).body.role).toBe("admin");
    // with a second manager or admin, the first can step down
    expect((await mgr().put(`/s/staff/${manager.id}`, { role: "rep" })).status).toBe(200);
  });

  it("teams: create, list, rename and set members, delete (quotes lose the team, rules are removed)", async () => {
    const { rep } = await people();
    const created = await mgr().post("/s/teams", { name: "  Windows ", memberIds: [rep.id] });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Windows", memberIds: [rep.id] });
    expect((await h.s.get("/s/teams")).body.items).toEqual([created.body]);
    const renamed = await mgr().put(`/s/teams/${created.body.id}`, { name: "Windows & doors", memberIds: [] });
    expect(renamed.body).toMatchObject({ name: "Windows & doors", memberIds: [] });
    // memberIds omitted on PUT keeps membership
    await mgr().put(`/s/teams/${created.body.id}`, { name: "W", memberIds: [rep.id] });
    expect((await mgr().put(`/s/teams/${created.body.id}`, { name: "W2" })).body.memberIds).toEqual([rep.id]);

    const q = await h.c.post("/c/quotes", { title: "t", lines: [{ variantId: "gid://shopify/ProductVariant/2", qty: 1 }], companyLocationId: "gid://shopify/CompanyLocation/1" });
    await h.prisma.quote.update({ where: { id: q.body.id }, data: { teamId: created.body.id } });
    await mgr().put("/s/settings", { defaultPriceFloorPct: 15, routing: { autoAssignByCompany: true, rules: [{ companyId: "gid://shopify/Company/1", teamId: created.body.id }] } });
    const del = await mgr().del(`/s/teams/${created.body.id}`);
    expect(del.status).toBe(204);
    expect((await h.prisma.quote.findUniqueOrThrow({ where: { id: q.body.id } })).teamId).toBeNull();
    expect(await h.prisma.routingRule.count()).toBe(0);
    expect((await h.s.get("/s/teams")).body.items).toEqual([]);
  });

  it("team errors: rep 403, bad name 400, unknown member 422, unknown team 404, default team cannot be deleted", async () => {
    await people();
    expect((await h.s.post("/s/teams", { name: "X" })).status).toBe(403);
    expect((await mgr().post("/s/teams", { name: "  " })).status).toBe(400);
    expect((await mgr().post("/s/teams", { name: "X", memberIds: ["ghost"] })).status).toBe(422);
    expect((await mgr().put("/s/teams/nope", { name: "X" })).status).toBe(404);
    expect((await mgr().del("/s/teams/nope")).status).toBe(404);
    const t = (await mgr().post("/s/teams", { name: "Default" })).body;
    expect((await h.s.put(`/s/teams/${t.id}`, { name: "Y" })).status).toBe(403);
    expect((await h.s.del(`/s/teams/${t.id}`)).status).toBe(403);
    await mgr().put("/s/settings", { defaultPriceFloorPct: 15, routing: { defaultTeamId: t.id, autoAssignByCompany: false, rules: [] } });
    const refused = await mgr().del(`/s/teams/${t.id}`);
    expect(refused.status).toBe(400);
    expect(refused.body.details).toMatchObject({ field: "defaultTeamId" });
    expect(await h.prisma.team.count()).toBe(1);
  });

  it("settings: copy-all-alerts address is saved lowercase, kept when omitted, cleared with blank, and must be an email", async () => {
    const base = { defaultPriceFloorPct: 15, routing: { autoAssignByCompany: false, rules: [] } };
    const put = await mgr().put("/s/settings", { ...base, notifications: { copyAllAlertsTo: " Mike@DSGdist.com " } });
    expect(put.status).toBe(200);
    expect(put.body.notifications).toEqual({ copyAllAlertsTo: "mike@dsgdist.com" });
    expect((await mgr().put("/s/settings", base)).body.notifications.copyAllAlertsTo).toBe("mike@dsgdist.com"); // omitted = unchanged
    expect((await mgr().put("/s/settings", { ...base, notifications: { copyAllAlertsTo: "not an email" } })).status).toBe(400);
    expect((await h.s.put("/s/settings", { ...base, notifications: { copyAllAlertsTo: "x@y.com" } })).status).toBe(403);
    expect((await mgr().put("/s/settings", { ...base, notifications: { copyAllAlertsTo: "" } })).body.notifications.copyAllAlertsTo).toBeNull();
    expect((await mgr().put("/s/settings", { ...base, notifications: { copyAllAlertsTo: "a@b.com" } })).body.notifications.copyAllAlertsTo).toBe("a@b.com");
    expect((await mgr().put("/s/settings", { ...base, notifications: { copyAllAlertsTo: null } })).body.notifications.copyAllAlertsTo).toBeNull();
  });

  it("settings: defaults, full replace of routing rules, ids kept, validation", async () => {
    const { rep } = await people();
    expect((await h.s.get("/s/settings")).body).toEqual({ defaultPriceFloorPct: 15, routing: { defaultTeamId: null, autoAssignByCompany: false, rules: [] }, notifications: { copyAllAlertsTo: null } });
    const team = (await mgr().post("/s/teams", { name: "T" })).body;
    const put = await mgr().put("/s/settings", {
      defaultPriceFloorPct: 12.5,
      routing: { defaultTeamId: team.id, autoAssignByCompany: true, rules: [{ companyId: "gid://shopify/Company/1", repId: rep.id }, { companyId: "gid://shopify/Company/2", teamId: team.id }] },
    });
    expect(put.status).toBe(200);
    expect(put.body.defaultPriceFloorPct).toBe(12.5);
    expect(put.body.routing.rules).toHaveLength(2);
    expect(put.body.routing.rules[0]).toMatchObject({ companyId: "gid://shopify/Company/1", repId: rep.id, teamId: null });
    // echoing the document back (with ids and companyName) replaces in place; dropping a rule removes it
    const again = await mgr().put("/s/settings", { ...put.body, routing: { ...put.body.routing, rules: [put.body.routing.rules[1]] } });
    expect(again.body.routing.rules).toHaveLength(1);
    expect(again.body.routing.rules[0].id).toBe(put.body.routing.rules[1].id);
    expect((await h.s.get("/s/settings")).body).toEqual(again.body);
    // the shop default floor now applies to staff without their own value
    expect((await h.s.get("/s/me")).body.effectivePriceFloorPct).toBe(12.5);
  });

  it("settings errors: rep 403, bad percent 400, rule without rep or team 422, unknown rep or team 422", async () => {
    await people();
    const ok = { defaultPriceFloorPct: 15, routing: { autoAssignByCompany: false, rules: [] } };
    expect((await h.s.put("/s/settings", ok)).status).toBe(403);
    expect((await mgr().put("/s/settings", { ...ok, defaultPriceFloorPct: 150 })).status).toBe(400);
    expect((await mgr().put("/s/settings", { defaultPriceFloorPct: 15 })).status).toBe(400);
    expect((await mgr().put("/s/settings", { ...ok, routing: { autoAssignByCompany: true, rules: [{ companyId: "c1" }] } })).status).toBe(422);
    expect((await mgr().put("/s/settings", { ...ok, routing: { autoAssignByCompany: true, rules: [{ companyId: "c1", repId: "ghost" }] } })).status).toBe(422);
    expect((await mgr().put("/s/settings", { ...ok, routing: { autoAssignByCompany: true, rules: [{ companyId: "c1", teamId: "ghost" }] } })).status).toBe(422);
    expect((await mgr().put("/s/settings", { ...ok, routing: { defaultTeamId: "ghost", autoAssignByCompany: true, rules: [] } })).status).toBe(422);
    expect((await h.s.get("/s/settings")).body.routing.rules).toEqual([]);
  });

  it("saved replies: personal ones are private; managers manage shared ones; PUT replaces the caller's set", async () => {
    await people();
    const mine = await h.s.put("/s/saved-replies", { items: [{ title: "Thanks", body: "Thanks for your quote request." }] });
    expect(mine.status).toBe(200);
    expect(mine.body.items).toEqual([expect.objectContaining({ title: "Thanks", shared: false })]);
    const shared = await mgr().put("/s/saved-replies", { items: [{ title: "Terms", body: "Net 30.", shared: true }] });
    expect(shared.body.items).toEqual([expect.objectContaining({ title: "Terms", shared: true })]);
    // rep sees own + shared; manager sees shared only (rep's personal reply is private)
    expect((await h.s.get("/s/saved-replies")).body.items.map((i: any) => i.title).sort()).toEqual(["Terms", "Thanks"]);
    expect((await mgr().get("/s/saved-replies")).body.items.map((i: any) => i.title)).toEqual(["Terms"]);
    // updating by id, then deleting by omission
    const id = mine.body.items.find((i: any) => i.title === "Thanks").id;
    const upd = await h.s.put("/s/saved-replies", { items: [{ id, title: "Thanks!", body: "Updated" }] });
    expect(upd.body.items.find((i: any) => i.id === id)).toMatchObject({ title: "Thanks!", body: "Updated" });
    expect((await h.s.get("/s/saved-replies")).body.items.map((i: any) => i.title)).toEqual(["Terms", "Thanks!"]); // shared kept: rep cannot replace it
    await h.s.put("/s/saved-replies", { items: [] });
    expect((await h.s.get("/s/saved-replies")).body.items.map((i: any) => i.title)).toEqual(["Terms"]);
  });

  it("saved reply errors: rep cannot create shared (403), cannot touch another's reply (422), bad body 400", async () => {
    await people();
    const theirs = (await mgr().put("/s/saved-replies", { items: [{ title: "Mine", body: "m" }] })).body.items[0];
    expect((await h.s.put("/s/saved-replies", { items: [{ title: "S", body: "s", shared: true }] })).status).toBe(403);
    const other = await h.s.put("/s/saved-replies", { items: [{ id: theirs.id, title: "Hijack", body: "x" }] });
    expect(other.status).toBe(422);
    expect((await h.s.put("/s/saved-replies", { items: [{ title: "", body: "x" }] })).status).toBe(400);
    expect((await h.s.put("/s/saved-replies", {})).status).toBe(400);
    expect((await h.s.put("/s/saved-replies", { items: [{ id: theirs.id, title: "a", body: "b" }, { id: theirs.id, title: "a", body: "b" }] })).status).toBe(422);
    expect((await mgr().get("/s/saved-replies")).body.items[0].title).toBe("Mine");
  });

  it("GET /s/customers searches the Shopify gateway (min 2 characters)", async () => {
    await people();
    const r = await h.s.get("/s/customers?q=dana");
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(r.body.items[0]).toEqual(expect.objectContaining({ customerId: expect.any(String), name: expect.any(String), email: expect.any(String) }));
    expect(r.body.items[0].locations.length).toBeGreaterThan(0);
    expect((await h.s.get("/s/customers?q=zzzzzz-nobody")).body.items).toEqual([]);
    expect((await h.s.get("/s/customers?q=a")).status).toBe(400);
    expect((await h.s.get("/s/customers")).status).toBe(400);
    expect((await h.raw({ method: "GET", url: "/s/customers?q=dana" })).status).toBe(401);
  });
});
