/**
 * RUNNABLE LAYER: the staff endpoints added by contract 0.2.0 (docs/CONTRACT-FOLLOWUPS.md API-12, API-13, API-16):
 *   GET /s/me, GET /s/staff, PUT /s/staff/{id}, /s/teams, /s/settings, /s/saved-replies, GET /s/customers.
 * Every response is validated against docs/openapi.yaml by the harness. Roles are explicit in the fixtures
 * (support/world.ts): admin Adam, manager Maya, reps Rita and Ross.
 */
import { describe, expect, it } from "vitest";
import { claimAndPrice, ok, submitted } from "./support/flows";
import * as F from "./support/fixtures";
import { useWorld } from "./support/world";

const ids = (items: { id: string }[]) => items.map((i) => i.id);

describe("GET /s/me", () => {
  const w = useWorld();

  it("reports role, capabilities and the effective price floor for each role", async () => {
    const rep = ok(await w.rep1.get("/s/me"), 200, "rep");
    expect(rep).toMatchObject({ id: w.staff.rep1.id, name: F.REP1.name, email: F.REP1.email, role: "rep", teamIds: [], priceFloorPct: null, effectivePriceFloorPct: 15, canApproveFloor: false, canEditSettings: false });
    expect(ok(await w.manager.get("/s/me"), 200, "manager")).toMatchObject({ role: "manager", canApproveFloor: true, canEditSettings: true });
    expect(ok(await w.admin.get("/s/me"), 200, "admin")).toMatchObject({ role: "admin", canApproveFloor: true, canEditSettings: true });
  });

  it("effectivePriceFloorPct is the personal override, else the shop default from settings", async () => {
    ok(await w.manager.put(`/s/staff/${w.staff.rep1.id}`, { priceFloorPct: 7.5 }), 200, "personal floor");
    expect(ok(await w.rep1.get("/s/me"), 200, "me")).toMatchObject({ priceFloorPct: 7.5, effectivePriceFloorPct: 7.5 });
    const settings = ok(await w.manager.get("/s/settings"), 200, "settings");
    ok(await w.manager.put("/s/settings", { ...settings, defaultPriceFloorPct: 22 }), 200, "new default");
    expect(ok(await w.rep1.get("/s/me"), 200, "me")).toMatchObject({ priceFloorPct: 7.5, effectivePriceFloorPct: 7.5 });
    expect(ok(await w.rep2.get("/s/me"), 200, "rep2")).toMatchObject({ priceFloorPct: null, effectivePriceFloorPct: 22 });
    ok(await w.manager.put(`/s/staff/${w.staff.rep1.id}`, { priceFloorPct: null }), 200, "reset");
    expect(ok(await w.rep1.get("/s/me"), 200, "me")).toMatchObject({ priceFloorPct: null, effectivePriceFloorPct: 22 });
  });

  it("teamIds come from team membership", async () => {
    const t = ok(await w.manager.post("/s/teams", { name: "East", memberIds: [w.staff.rep1.id] }), 201, "team");
    expect(ok(await w.rep1.get("/s/me"), 200, "me").teamIds).toEqual([t.id]);
    expect(ok(await w.rep2.get("/s/me"), 200, "me").teamIds).toEqual([]);
  });

  it("bootstrap: the first staff member of an empty shop becomes admin, everyone after that a rep", async () => {
    await w.prisma.staff.deleteMany();
    const first = ok(await w.staffAs("fresh-1").get("/s/me"), 200, "first");
    expect(first).toMatchObject({ role: "admin", canApproveFloor: true, canEditSettings: true });
    const second = ok(await w.staffAs("fresh-2").get("/s/me"), 200, "second");
    expect(second).toMatchObject({ role: "rep", canApproveFloor: false, canEditSettings: false });
    expect(ok(await w.staffAs("fresh-1").get("/s/me"), 200, "again").id).toBe(first.id); // stable row
  });

  it("a deactivated staff member is refused on every route with 403", async () => {
    ok(await w.manager.put(`/s/staff/${w.staff.rep2.id}`, { active: false }), 200, "deactivate");
    for (const url of ["/s/me", "/s/quotes", "/s/staff", "/s/reports/summary"]) {
      const r = await w.rep2.get(url);
      expect(r.status, url).toBe(403);
      expect(r.body.code, url).toBe("FORBIDDEN");
    }
    ok(await w.manager.put(`/s/staff/${w.staff.rep2.id}`, { active: true }), 200, "reactivate");
    expect((await w.rep2.get("/s/me")).status).toBe(200);
  });
});

describe("staff directory: GET /s/staff and PUT /s/staff/{id}", () => {
  const w = useWorld();

  it("lists everyone sorted by name; any staff member may read it; ?active filters", async () => {
    const all = ok(await w.rep1.get("/s/staff"), 200, "list");
    expect(all.items.map((s: any) => s.name)).toEqual([F.ADMIN.name, F.MANAGER.name, F.REP1.name, F.REP2.name]);
    expect(all.items.find((s: any) => s.id === w.staff.rep1.id)).toMatchObject({ email: F.REP1.email, role: "rep", teamIds: [], priceFloorPct: null, active: true });
    expect(ok(await w.rep1.get("/s/staff?active=false"), 200, "inactive").items).toEqual([]);
    ok(await w.manager.put(`/s/staff/${w.staff.rep2.id}`, { active: false }), 200, "deactivate");
    expect(ids(ok(await w.rep1.get("/s/staff?active=false"), 200, "inactive").items)).toEqual([w.staff.rep2.id]);
    expect(ids(ok(await w.rep1.get("/s/staff?active=true"), 200, "active").items)).not.toContain(w.staff.rep2.id);
    expect((await w.rep1.get("/s/staff?active=maybe", { loose: true })).status).toBe(400);
  });

  it("reps cannot change anyone (403); managers can set personal floor, teams, active and role; bad input is 4xx", async () => {
    const denied = await w.rep1.put(`/s/staff/${w.staff.rep2.id}`, { priceFloorPct: 1 });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("FORBIDDEN");
    expect((await w.rep1.put(`/s/staff/${w.staff.rep1.id}`, { role: "admin" })).status).toBe(403); // no self promotion

    const team = ok(await w.manager.post("/s/teams", { name: "West" }), 201, "team");
    const updated = ok(await w.manager.put(`/s/staff/${w.staff.rep2.id}`, { priceFloorPct: 5, teamIds: [team.id] }), 200, "update");
    expect(updated).toMatchObject({ id: w.staff.rep2.id, role: "rep", priceFloorPct: 5, teamIds: [team.id], active: true });
    expect(ok(await w.manager.get("/s/teams"), 200, "teams").items[0].memberIds).toEqual([w.staff.rep2.id]);

    expect((await w.manager.put(`/s/staff/${w.staff.rep2.id}`, {}, { loose: true })).status).toBe(400);
    expect((await w.manager.put(`/s/staff/${w.staff.rep2.id}`, { priceFloorPct: 101 }, { loose: true })).status).toBe(400);
    expect((await w.manager.put(`/s/staff/${w.staff.rep2.id}`, { priceFloorPct: -1 }, { loose: true })).status).toBe(400);
    expect((await w.manager.put(`/s/staff/${w.staff.rep2.id}`, { role: "owner" }, { loose: true })).status).toBe(400);
    expect((await w.manager.put(`/s/staff/${w.staff.rep2.id}`, { teamIds: ["no-such-team"] })).status).toBe(422);
    expect((await w.manager.put("/s/staff/ghost", { active: true })).status).toBe(404);
    // Unchanged after the failures; clearing teams and the personal floor works.
    const cleared = ok(await w.manager.put(`/s/staff/${w.staff.rep2.id}`, { teamIds: [], priceFloorPct: null }), 200, "clear");
    expect(cleared).toMatchObject({ teamIds: [], priceFloorPct: null });
  });

  it("only an admin grants or removes the admin role; a manager can grant manager", async () => {
    const byManager = await w.manager.put(`/s/staff/${w.staff.rep1.id}`, { role: "admin" });
    expect(byManager.status).toBe(403);
    expect((await w.manager.put(`/s/staff/${w.staff.admin.id}`, { role: "rep" })).status).toBe(403);
    expect(ok(await w.manager.put(`/s/staff/${w.staff.rep1.id}`, { role: "manager" }), 200, "grant manager").role).toBe("manager");
    expect(ok(await w.admin.put(`/s/staff/${w.staff.rep2.id}`, { role: "admin" }), 200, "grant admin").role).toBe("admin");
    expect(ok(await w.admin.put(`/s/staff/${w.staff.rep2.id}`, { role: "rep" }), 200, "remove admin").role).toBe("rep");
  });

  it("a new role takes effect on the next call: a promoted rep can approve floors, a demoted manager cannot", async () => {
    const q = await submitted(w.dana, [{ variantId: F.V_THIN, qty: 1 }]);
    await claimAndPrice(w.rep1, q.id);
    expect((await w.rep2.post(`/s/quotes/${q.id}/approve-floor`, {})).status).toBe(403);
    ok(await w.manager.put(`/s/staff/${w.staff.rep2.id}`, { role: "manager" }), 200, "promote");
    ok(await w.rep2.post(`/s/quotes/${q.id}/approve-floor`, {}), 200, "now allowed");
    ok(await w.admin.put(`/s/staff/${w.staff.rep2.id}`, { role: "rep" }), 200, "demote");
    expect((await w.rep2.post(`/s/quotes/${q.id}/approve-floor`, {})).status).toBe(403);
  });

  it("the shop always keeps one active manager or admin", async () => {
    ok(await w.admin.put(`/s/staff/${w.staff.manager.id}`, { active: false }), 200, "deactivate manager (admin remains)");
    const last = await w.admin.put(`/s/staff/${w.staff.admin.id}`, { role: "rep" });
    expect(last.status).toBe(400);
    expect(last.body.code).toBe("BAD_REQUEST");
    expect((await w.admin.put(`/s/staff/${w.staff.admin.id}`, { active: false })).status).toBe(400);
    expect(ok(await w.admin.get("/s/me"), 200, "still admin").role).toBe("admin");
  });
});

describe("teams: /s/teams", () => {
  const w = useWorld();

  it("create, list, rename and replace members, delete (managers and admins; reps only read)", async () => {
    const a = ok(await w.manager.post("/s/teams", { name: "Inside sales", memberIds: [w.staff.rep1.id, w.staff.rep2.id] }), 201, "create");
    expect(a).toMatchObject({ name: "Inside sales" });
    expect([...a.memberIds].sort()).toEqual([w.staff.rep1.id, w.staff.rep2.id].sort());
    const b = ok(await w.admin.post("/s/teams", { name: "Field" }), 201, "admin create");
    expect(b.memberIds).toEqual([]);
    expect((await w.rep1.post("/s/teams", { name: "Nope" })).status).toBe(403);

    expect(ok(await w.rep1.get("/s/teams"), 200, "rep read").items.map((t: any) => t.name)).toEqual(["Field", "Inside sales"]);

    const renamed = ok(await w.manager.put(`/s/teams/${a.id}`, { name: "Inside sales (US)", memberIds: [w.staff.rep1.id] }), 200, "update");
    expect(renamed).toMatchObject({ id: a.id, name: "Inside sales (US)", memberIds: [w.staff.rep1.id] });
    // memberIds omitted on PUT keeps the current members.
    expect(ok(await w.manager.put(`/s/teams/${a.id}`, { name: "Inside" }), 200, "rename only").memberIds).toEqual([w.staff.rep1.id]);
    expect((await w.rep1.put(`/s/teams/${a.id}`, { name: "Hijack" })).status).toBe(403);
    expect((await w.rep1.del(`/s/teams/${a.id}`)).status).toBe(403);

    expect((await w.manager.del(`/s/teams/${b.id}`)).status).toBe(204);
    expect(ok(await w.manager.get("/s/teams"), 200, "after delete").items.map((t: any) => t.id)).toEqual([a.id]);
  });

  it("validation: blank or over-long name 400, unknown member 422, unknown team 404", async () => {
    expect((await w.manager.post("/s/teams", { name: "" }, { loose: true })).status).toBe(400);
    expect((await w.manager.post("/s/teams", { name: "x".repeat(81) }, { loose: true })).status).toBe(400);
    expect((await w.manager.post("/s/teams", { name: "T", memberIds: ["ghost"] })).status).toBe(422);
    expect((await w.manager.put("/s/teams/ghost", { name: "T" })).status).toBe(404);
    expect((await w.manager.del("/s/teams/ghost")).status).toBe(404);
    const t = ok(await w.manager.post("/s/teams", { name: "T" }), 201, "create");
    expect((await w.manager.put(`/s/teams/${t.id}`, { name: "T", memberIds: ["ghost"] })).status).toBe(422);
    expect(ok(await w.manager.get("/s/teams"), 200, "unchanged").items).toHaveLength(1);
  });

  it("deleting a team keeps its quotes' rep, clears teamId, drops routing rules, and the default team is protected (400)", async () => {
    const t1 = ok(await w.manager.post("/s/teams", { name: "Default team" }), 201, "t1");
    const t2 = ok(await w.manager.post("/s/teams", { name: "Other team" }), 201, "t2");
    const base = ok(await w.manager.get("/s/settings"), 200, "settings");
    ok(await w.manager.put("/s/settings", { ...base, routing: { defaultTeamId: t1.id, autoAssignByCompany: true, rules: [{ companyId: F.ACME.id, repId: w.staff.rep1.id, teamId: t2.id }] } }), 200, "settings");

    const q = await submitted(w.dana);
    expect(ok(await w.rep1.get(`/s/quotes/${q.id}`), 200, "routed")).toMatchObject({ assignedRepId: w.staff.rep1.id, teamId: t2.id });

    const protectedDelete = await w.manager.del(`/s/teams/${t1.id}`);
    expect(protectedDelete.status).toBe(400);
    expect(protectedDelete.body).toMatchObject({ code: "BAD_REQUEST", details: { field: "defaultTeamId" } });
    expect(ok(await w.manager.get("/s/teams"), 200, "still there").items).toHaveLength(2);

    expect((await w.manager.del(`/s/teams/${t2.id}`)).status).toBe(204);
    expect(ok(await w.rep1.get(`/s/quotes/${q.id}`), 200, "after delete")).toMatchObject({ assignedRepId: w.staff.rep1.id, teamId: null });
    expect(ok(await w.manager.get("/s/settings"), 200, "rules").routing.rules).toEqual([]);

    // Pointing the default elsewhere unprotects it.
    const s = ok(await w.manager.get("/s/settings"), 200, "settings");
    ok(await w.manager.put("/s/settings", { ...s, routing: { ...s.routing, defaultTeamId: null } }), 200, "clear default");
    expect((await w.manager.del(`/s/teams/${t1.id}`)).status).toBe(204);
  });
});

describe("settings: /s/settings", () => {
  const w = useWorld();
  const thin = [{ variantId: F.V_THIN, qty: 1 }]; // 8.57% margin at 100.00 (cost 91.43)

  it("defaults, then a full replace (managers and admins only); rules keep their ids and show the company name", async () => {
    expect(ok(await w.rep1.get("/s/settings"), 200, "rep can read")).toEqual({ defaultPriceFloorPct: 15, routing: { defaultTeamId: null, autoAssignByCompany: false, rules: [] } });
    const team = ok(await w.manager.post("/s/teams", { name: "East" }), 201, "team");
    const body = { defaultPriceFloorPct: 12.5, routing: { defaultTeamId: team.id, autoAssignByCompany: true, rules: [{ companyId: F.ACME.id, repId: w.staff.rep1.id }, { companyId: F.OTHERCO.id, teamId: team.id }] } };
    expect((await w.rep1.put("/s/settings", body)).status).toBe(403);
    const saved = ok(await w.manager.put("/s/settings", body), 200, "save");
    expect(saved.defaultPriceFloorPct).toBe(12.5);
    expect(saved.routing).toMatchObject({ defaultTeamId: team.id, autoAssignByCompany: true });
    expect(saved.routing.rules).toHaveLength(2);
    expect(saved.routing.rules[0]).toMatchObject({ companyId: F.ACME.id, repId: w.staff.rep1.id, teamId: null });
    expect(saved.routing.rules[1]).toMatchObject({ companyId: F.OTHERCO.id, repId: null, teamId: team.id });
    expect(ok(await w.rep2.get("/s/settings"), 200, "reread")).toEqual(saved);

    // PUT is a full replace: echoing it back (read-only companyName included) keeps the rule ids; dropping a rule removes it.
    const echoed = ok(await w.admin.put("/s/settings", saved), 200, "echo");
    expect(echoed.routing.rules.map((r: any) => r.id)).toEqual(saved.routing.rules.map((r: any) => r.id));
    const trimmed = ok(await w.admin.put("/s/settings", { ...saved, routing: { ...saved.routing, rules: [saved.routing.rules[1]] } }), 200, "trim");
    expect(trimmed.routing.rules.map((r: any) => r.id)).toEqual([saved.routing.rules[1].id]);
    expect(ok(await w.admin.put("/s/settings", { ...saved, routing: { ...saved.routing, rules: [] } }), 200, "empty").routing.rules).toEqual([]);
  });

  it("validation: floor outside 0-100 is 400; a rule needs a rep or a team; unknown rep, team or default team is 422; nothing is saved", async () => {
    const base = { defaultPriceFloorPct: 15, routing: { defaultTeamId: null, autoAssignByCompany: false, rules: [] as any[] } };
    expect((await w.manager.put("/s/settings", { ...base, defaultPriceFloorPct: 101 }, { loose: true })).status).toBe(400);
    expect((await w.manager.put("/s/settings", { ...base, defaultPriceFloorPct: -0.1 }, { loose: true })).status).toBe(400);
    expect((await w.manager.put("/s/settings", { defaultPriceFloorPct: 15 }, { loose: true })).status).toBe(400); // routing is required
    const rule = (extra: object) => ({ ...base, defaultPriceFloorPct: 99, routing: { ...base.routing, rules: [{ companyId: F.ACME.id, ...extra }] } });
    expect((await w.manager.put("/s/settings", rule({}), { loose: true })).status).toBe(422);
    expect((await w.manager.put("/s/settings", rule({ repId: "ghost" }))).status).toBe(422);
    expect((await w.manager.put("/s/settings", rule({ teamId: "ghost" }))).status).toBe(422);
    expect((await w.manager.put("/s/settings", { ...base, defaultPriceFloorPct: 99, routing: { ...base.routing, defaultTeamId: "ghost" } })).status).toBe(422);
    expect(ok(await w.manager.get("/s/settings"), 200, "unchanged").defaultPriceFloorPct).toBe(15);
  });

  it("routing on submit: a matching company rule assigns rep and team; others get the default team; the toggle switches rules off", async () => {
    const east = ok(await w.manager.post("/s/teams", { name: "East" }), 201, "east");
    const west = ok(await w.manager.post("/s/teams", { name: "West" }), 201, "west");
    ok(
      await w.manager.put("/s/settings", { defaultPriceFloorPct: 15, routing: { defaultTeamId: west.id, autoAssignByCompany: true, rules: [{ companyId: F.ACME.id, repId: w.staff.rep2.id, teamId: east.id }] } }),
      200,
      "settings",
    );
    const dana = await submitted(w.dana);
    expect(ok(await w.rep1.get(`/s/quotes/${dana.id}`), 200, "acme")).toMatchObject({ assignedRepId: w.staff.rep2.id, teamId: east.id, status: "SUBMITTED" });
    const bea = await submitted(w.bea);
    expect(ok(await w.rep1.get(`/s/quotes/${bea.id}`), 200, "otherco")).toMatchObject({ assignedRepId: null, teamId: west.id });
    // Assigned quotes drop out of the "unassigned" tab; the team-only one stays.
    expect(ids(ok(await w.rep1.get("/s/quotes?tab=unassigned"), 200, "unassigned").items)).toEqual([bea.id]);

    // Rules are stored but ignored when the toggle is off; the default team still applies.
    const cur = ok(await w.manager.get("/s/settings"), 200, "cur");
    ok(await w.manager.put("/s/settings", { ...cur, routing: { ...cur.routing, autoAssignByCompany: false } }), 200, "off");
    const again = await submitted(w.drew);
    expect(ok(await w.rep1.get(`/s/quotes/${again.id}`), 200, "off")).toMatchObject({ assignedRepId: null, teamId: west.id });

    // A rep who is deactivated is not auto-assigned.
    ok(await w.manager.put("/s/settings", cur), 200, "on again");
    ok(await w.manager.put(`/s/staff/${w.staff.rep2.id}`, { active: false }), 200, "deactivate");
    const skip = await submitted(w.dana);
    expect(ok(await w.rep1.get(`/s/quotes/${skip.id}`), 200, "inactive rep")).toMatchObject({ assignedRepId: null, teamId: east.id });
  });

  it("the default floor drives Send: lowering it lets a thin line through, raising it blocks a healthy one", async () => {
    const q = await submitted(w.dana, thin);
    await claimAndPrice(w.rep1, q.id);
    expect((await w.rep1.post(`/s/quotes/${q.id}/send`)).body.code).toBe("FLOOR_APPROVAL_REQUIRED");
    const s = ok(await w.manager.get("/s/settings"), 200, "settings");
    ok(await w.manager.put("/s/settings", { ...s, defaultPriceFloorPct: 5 }), 200, "lower");
    ok(await w.rep1.post(`/s/quotes/${q.id}/send`), 200, "now sendable");

    const healthy = await submitted(w.dana, [{ variantId: F.V_PIPE, qty: 1 }]); // 120.00 on cost 61.37 = 48.9%
    const staff = await claimAndPrice(w.rep1, healthy.id);
    expect(staff.workingLines[0].belowFloor).toBe(false);
    ok(await w.manager.put("/s/settings", { ...s, defaultPriceFloorPct: 60 }), 200, "raise");
    expect(ok(await w.rep1.get(`/s/quotes/${healthy.id}`), 200, "reflag").workingLines[0].belowFloor).toBe(true);
    expect((await w.rep1.post(`/s/quotes/${healthy.id}/send`)).status).toBe(422);
    // A personal floor overrides the default for that rep only.
    ok(await w.manager.put(`/s/staff/${w.staff.rep1.id}`, { priceFloorPct: 10 }), 200, "personal");
    ok(await w.rep1.post(`/s/quotes/${healthy.id}/send`), 200, "personal floor wins");
  });
});

describe("saved replies: /s/saved-replies", () => {
  const w = useWorld();

  it("personal replies are private to their owner; shared replies (managers and admins only) are visible to everyone", async () => {
    expect(ok(await w.rep1.get("/s/saved-replies"), 200, "empty").items).toEqual([]);
    const mine = ok(await w.rep1.put("/s/saved-replies", { items: [{ title: "On it", body: "I'm on it, back to you shortly." }] }), 200, "rep personal");
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]).toMatchObject({ title: "On it", shared: false });
    expect(ok(await w.rep2.get("/s/saved-replies"), 200, "rep2").items).toEqual([]);
    expect(ok(await w.manager.get("/s/saved-replies"), 200, "manager").items).toEqual([]);

    const denied = await w.rep1.put("/s/saved-replies", { items: [{ id: mine.items[0].id, title: "On it", body: "x" }, { title: "Policy", body: "Net 30", shared: true }] });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("FORBIDDEN");
    expect(ok(await w.rep1.get("/s/saved-replies"), 200, "unchanged").items).toHaveLength(1);

    const shared = ok(await w.manager.put("/s/saved-replies", { items: [{ title: "Terms", body: "Our terms are Net 30.", shared: true }, { title: "Mine", body: "Maya's own." }] }), 200, "manager");
    expect(shared.items.map((i: any) => [i.title, i.shared])).toEqual([["Terms", true], ["Mine", false]]);
    // Rita sees the shared one and her own, not Maya's personal one.
    expect(ok(await w.rep1.get("/s/saved-replies"), 200, "rita").items.map((i: any) => i.title).sort()).toEqual(["On it", "Terms"]);
    expect(ok(await w.rep2.get("/s/saved-replies"), 200, "ross").items.map((i: any) => i.title)).toEqual(["Terms"]);
  });

  it("PUT replaces the caller's replaceable set: ids are kept on update, omitted items are deleted, other people's replies are untouched", async () => {
    const m = ok(await w.manager.put("/s/saved-replies", { items: [{ title: "Terms", body: "Net 30", shared: true }] }), 200, "shared");
    const r1 = ok(await w.rep1.put("/s/saved-replies", { items: [{ title: "A", body: "a" }, { title: "B", body: "b" }] }), 200, "rep1");
    const aId = r1.items.find((i: any) => i.title === "A").id;
    // Rep sends back only A (edited): B is deleted, the shared reply stays (not in the rep's replaceable set).
    const after = ok(await w.rep1.put("/s/saved-replies", { items: [{ id: aId, title: "A2", body: "a2" }] }), 200, "edit");
    expect(after.items.map((i: any) => [i.title, i.shared]).sort()).toEqual([["A2", false], ["Terms", true]]);
    expect(after.items.find((i: any) => i.title === "A2").id).toBe(aId);
    expect(after.items.find((i: any) => i.title === "Terms").id).toBe(m.items[0].id);
    // The rep cannot reach the shared reply (or another rep's) by id.
    const hijack = await w.rep1.put("/s/saved-replies", { items: [{ id: m.items[0].id, title: "Terms", body: "Net 90" }] });
    expect(hijack.status).toBe(422);
    const r2 = ok(await w.rep2.put("/s/saved-replies", { items: [{ title: "C", body: "c" }] }), 200, "rep2");
    expect((await w.rep1.put("/s/saved-replies", { items: [{ id: r2.items.find((i: any) => i.title === "C").id, title: "C", body: "stolen" }] })).status).toBe(422);
    expect(ok(await w.manager.get("/s/saved-replies"), 200, "manager still sees shared").items.find((i: any) => i.title === "Terms").body).toBe("Net 30");
    // An empty list clears only the caller's own personal replies.
    const cleared = ok(await w.rep1.put("/s/saved-replies", { items: [] }), 200, "clear");
    expect(cleared.items.map((i: any) => i.title)).toEqual(["Terms"]);
    expect(ok(await w.rep2.get("/s/saved-replies"), 200, "rep2 intact").items.map((i: any) => i.title).sort()).toEqual(["C", "Terms"]);
  });

  it("managers and admins can edit and delete shared replies; sharing a personal reply moves it out of the owner's private set", async () => {
    const m = ok(await w.manager.put("/s/saved-replies", { items: [{ title: "Terms", body: "Net 30", shared: true }] }), 200, "shared");
    const sid = m.items[0].id;
    const byAdmin = ok(await w.admin.put("/s/saved-replies", { items: [{ id: sid, title: "Terms v2", body: "Net 45", shared: true }] }), 200, "admin edits");
    expect(byAdmin.items[0]).toMatchObject({ id: sid, title: "Terms v2", body: "Net 45", shared: true });
    // Unsharing makes it personal to the admin who saved it: the manager no longer sees it.
    ok(await w.admin.put("/s/saved-replies", { items: [{ id: sid, title: "Terms v2", body: "Net 45", shared: false }] }), 200, "unshare");
    expect(ok(await w.manager.get("/s/saved-replies"), 200, "manager").items).toEqual([]);
    expect(ok(await w.admin.get("/s/saved-replies"), 200, "admin").items.map((i: any) => i.id)).toEqual([sid]);
    expect(ok(await w.admin.put("/s/saved-replies", { items: [] }), 200, "delete").items).toEqual([]);
  });

  it("validation: blank or over-long title, blank body, more than 100 items, duplicate ids", async () => {
    const put = (items: unknown[]) => w.rep1.put("/s/saved-replies", { items }, { loose: true });
    expect((await put([{ title: "", body: "x" }])).status).toBe(400);
    expect((await put([{ title: "x".repeat(81), body: "x" }])).status).toBe(400);
    expect((await put([{ title: "t", body: "" }])).status).toBe(400);
    expect((await put([{ title: "t", body: "x".repeat(5001) }])).status).toBe(400);
    expect((await put(Array.from({ length: 101 }, (_, i) => ({ title: `t${i}`, body: "b" })))).status).toBe(400);
    expect((await w.rep1.put("/s/saved-replies", {}, { loose: true })).status).toBe(400);
    const one = ok(await put([{ title: "t", body: "b" }]), 200, "one");
    const id = one.items[0].id;
    expect((await put([{ id, title: "t", body: "b" }, { id, title: "t2", body: "b2" }])).status).toBe(422);
    expect((await put([{ id: "ghost", title: "t", body: "b" }])).status).toBe(422);
    expect(ok(await w.rep1.get("/s/saved-replies"), 200, "unchanged").items).toHaveLength(1);
  });

  it("a saved reply is only text: using it as a staff message still goes through the normal message rules", async () => {
    const reply = ok(await w.manager.put("/s/saved-replies", { items: [{ title: "Hello", body: "Thanks for your request.", shared: true }] }), 200, "shared").items[0];
    const q = await submitted(w.dana);
    const msg = ok(await w.rep1.post(`/s/quotes/${q.id}/messages`, { body: reply.body }), 201, "send reply");
    expect(msg.body).toBe(reply.body);
    expect(ok(await w.dana.get(`/c/quotes/${q.id}/messages`), 200, "dealer").items.map((m: any) => m.body)).toContain(reply.body);
  });
});

describe("customer search: GET /s/customers", () => {
  const w = useWorld();

  it("matches name, email and company; returns the company locations; any staff member may search", async () => {
    const dana = ok(await w.rep1.get("/s/customers?q=dana"), 200, "name");
    expect(dana.items).toHaveLength(1);
    expect(dana.items[0]).toMatchObject({ customerId: F.DANA.id, name: F.DANA.name, email: "dana@acme.example.test", companyId: F.ACME.id, companyName: F.ACME.name });
    expect(dana.items[0].locations.map((l: any) => [l.companyLocationId, l.name])).toEqual([[F.LOC_ACME_MAIN, "Main"], [F.LOC_ACME_BRANCH, "Branch"]]);
    expect(ok(await w.rep1.get("/s/customers?q=ACME"), 200, "company, any case").items.map((c: any) => c.customerId).sort()).toEqual([F.DANA.id, F.DREW.id].sort());
    expect(ok(await w.rep1.get("/s/customers?q=otherco.example"), 200, "email").items.map((c: any) => c.customerId)).toEqual([F.BEA.id]);
    expect(ok(await w.rep1.get("/s/customers?q=zzzz-nobody"), 200, "none").items).toEqual([]);
    expect(ok(await w.rep1.get("/s/customers?q=acme&limit=1"), 200, "limit").items).toHaveLength(1);
  });

  it("q is required and needs at least 2 characters (400)", async () => {
    for (const url of ["/s/customers", "/s/customers?q=", "/s/customers?q=d", "/s/customers?q=%20d%20"]) {
      const r = await w.rep1.get(url, { loose: true });
      expect(r.status, url).toBe(400);
      expect(r.body.code, url).toBe("BAD_REQUEST");
    }
    expect((await w.rep1.get("/s/customers?q=dana&limit=0", { loose: true })).status).toBe(400);
  });

  it("picking a result's location creates the quote on that location, visible to that dealer's location only", async () => {
    const found = ok(await w.rep1.get("/s/customers?q=dana"), 200, "search").items[0];
    const branch = found.locations.find((l: any) => l.name === "Branch");
    const q = ok(
      await w.rep1.post("/s/quotes", { customerId: found.customerId, companyLocationId: branch.companyLocationId, title: "Branch order", lines: [{ variantId: F.V_VALVE, qty: 2 }] }),
      201,
      "create on behalf",
    );
    expect(q).toMatchObject({ companyLocationId: F.LOC_ACME_BRANCH, customerName: F.DANA.name, status: "DRAFT" });
    expect(ids(ok(await w.danaBranch.get("/c/quotes"), 200, "branch").items)).toEqual([q.id]);
    expect(ok(await w.dana.get("/c/quotes"), 200, "main").items).toEqual([]);
    // A location that is not the customer's is refused.
    expect((await w.rep1.post("/s/quotes", { customerId: found.customerId, companyLocationId: F.LOC_OTHER_HQ, title: "x" })).status).toBe(422);
  });
});

describe("inbox: tabCounts, rep filter, display-number search, itemCount, currencyCode", () => {
  const w = useWorld();
  const TABS = ["needs_response", "unassigned", "waiting_customer", "accepted", "expiring", "all"] as const;

  /** needs_response: unclaimed + claimed + change-requested; waiting: sent; accepted; expiring: sent within 3 days. */
  async function seed() {
    const unclaimed = await submitted(w.dana, [{ variantId: F.V_PIPE, qty: 3 }, { variantId: F.V_VALVE, qty: 10 }]);
    const claimed = await submitted(w.dana);
    await claimAndPrice(w.rep1, claimed.id);
    const sent = await submitted(w.bea);
    await claimAndPrice(w.rep2, sent.id);
    ok(await w.rep2.post(`/s/quotes/${sent.id}/send`), 200, "send");
    const soon = await submitted(w.dana);
    await claimAndPrice(w.rep1, soon.id, {}, { expiresAt: new Date(w.clock.now.getTime() + 2 * 86400_000).toISOString() });
    ok(await w.rep1.post(`/s/quotes/${soon.id}/send`), 200, "send soon");
    const acc = await submitted(w.dana);
    await claimAndPrice(w.rep1, acc.id);
    ok(await w.rep1.post(`/s/quotes/${acc.id}/send`), 200, "send");
    ok(await w.dana.post(`/c/quotes/${acc.id}/accept`, { versionNo: 1 }), 200, "accept");
    await submitted(w.drew).then(async (q) => ok(await w.drew.post(`/c/quotes/${q.id}/withdraw`), 200, "withdraw")); // back to DRAFT: private, in no tab
    return { unclaimed, claimed, sent, soon, acc };
  }

  it("summary.tabCounts equals the length of each tab's list, for all six tabs, and the legacy tiles agree", async () => {
    await seed();
    const summary = ok(await w.rep1.get("/s/reports/summary"), 200, "summary");
    expect(summary.tabCounts).toEqual({ needs_response: 2, unassigned: 1, waiting_customer: 2, accepted: 1, expiring: 1, all: 5 }); // the withdrawn quote is a private draft again: in no tab
    for (const t of TABS) {
      const list = ok(await w.rep1.get(`/s/quotes?tab=${t}&limit=100`), 200, t);
      expect(summary.tabCounts[t], t).toBe(list.items.length);
    }
    expect(summary).toMatchObject({ needsResponse: 2, unassigned: 1, expiringSoon: 1, acceptedThisWeek: 1 });
    // Counts move with the quotes: claiming the unclaimed one empties 'unassigned'.
    const un = ok(await w.rep1.get("/s/quotes?tab=unassigned"), 200, "un").items[0];
    ok(await w.rep2.post(`/s/quotes/${un.id}/claim`), 200, "claim");
    const after = ok(await w.rep1.get("/s/reports/summary"), 200, "after");
    expect(after.tabCounts).toMatchObject({ unassigned: 0, needs_response: 2, all: 5 });
  });

  it("?rep=me, ?rep=unassigned and ?rep=<staffId>", async () => {
    const s = await seed();
    const mine = ok(await w.rep1.get("/s/quotes?rep=me&limit=100"), 200, "me");
    expect(ids(mine.items).sort()).toEqual([s.claimed.id, s.soon.id, s.acc.id].sort());
    expect(ids(ok(await w.rep2.get("/s/quotes?rep=me"), 200, "rep2 me").items)).toEqual([s.sent.id]);
    expect(ids(ok(await w.rep1.get(`/s/quotes?rep=${w.staff.rep2.id}`), 200, "by id").items)).toEqual([s.sent.id]);
    expect(ids(ok(await w.rep1.get("/s/quotes?rep=unassigned"), 200, "unassigned").items)).toEqual([s.unclaimed.id]);
    expect(ok(await w.manager.get("/s/quotes?rep=me"), 200, "manager has none").items).toEqual([]);
    expect(ids(ok(await w.rep1.get("/s/quotes?tab=needs_response&rep=me"), 200, "tab + rep").items)).toEqual([s.claimed.id]);
  });

  it("q finds a quote by display number: Q-10001, q10001 and 10001 are the same search; it still searches text", async () => {
    const a = await submitted(w.dana, undefined, { title: "Harbor", job: "Harbor Tower" });
    const b = await submitted(w.dana, undefined, { title: "Mill", job: "Mill Street" });
    for (const term of [`Q-${a.number}`, `q${a.number}`, `${a.number}`, `q-${a.number}`]) {
      expect(ids(ok(await w.rep1.get(`/s/quotes?q=${encodeURIComponent(term)}`), 200, term).items), term).toEqual([a.id]);
    }
    expect(ids(ok(await w.rep1.get(`/s/quotes?q=Q-${b.number}`), 200, "b").items)).toEqual([b.id]);
    expect(ids(ok(await w.rep1.get("/s/quotes?q=harbor"), 200, "text").items)).toEqual([a.id]);
    expect(ok(await w.rep1.get("/s/quotes?q=Q-99999"), 200, "no such").items).toEqual([]);
    expect(ok(await w.rep1.get("/s/quotes?q=Q-123456789012345678901234567890"), 200, "huge number is a clean empty result").items).toEqual([]);
  });

  it("rows carry itemCount (lines, not units) and currencyCode; the staff quote carries them too", async () => {
    const q = await submitted(w.dana, [{ variantId: F.V_PIPE, qty: 3 }, { variantId: F.V_VALVE, qty: 10 }]);
    const row = ok(await w.rep1.get("/s/quotes"), 200, "inbox").items.find((i: any) => i.id === q.id);
    expect(row).toMatchObject({ itemCount: 2, currencyCode: "USD" });
    expect(ok(await w.rep1.get(`/s/quotes/${q.id}`), 200, "detail")).toMatchObject({ itemCount: 2, currencyCode: "USD" });
    const zero = ok(await w.rep1.post("/s/quotes", { customerId: F.DANA.id, title: "Empty" }), 201, "empty draft");
    expect(zero.itemCount).toBe(0);
  });
});

describe("staff quote editor fields", () => {
  const w = useWorld();

  it("paymentTerms and the customer contact come from the buyer (read only) and are never sent to the dealer", async () => {
    const b = w.shopify.buyers.get(F.DANA.id)!;
    b.paymentTerms = "Net 30";
    b.phone = "+13125550142";
    const q = await submitted(w.dana);
    const staff = ok(await w.rep1.get(`/s/quotes/${q.id}`), 200, "staff");
    expect(staff).toMatchObject({ paymentTerms: "Net 30", customerContactName: F.DANA.name, customerContactPhone: "+13125550142" });
    const view = ok(await w.dana.get(`/c/quotes/${q.id}`), 200, "dealer");
    expect(JSON.stringify(view)).not.toContain("+13125550142");
    expect(view).not.toHaveProperty("customerContactPhone");
  });

  it("workingExpiresAt is saved with the revision, becomes expiresAt on send and then resets; the default is now + 14 days", async () => {
    const q = await submitted(w.dana);
    const claimed = await claimAndPrice(w.rep1, q.id);
    expect(claimed.workingExpiresAt).toBeNull();
    const when = new Date(w.clock.now.getTime() + 9 * 86400_000).toISOString();
    const saved = await claimAndPriceAgain(w, q.id, when);
    expect(saved.workingExpiresAt).toBe(when);
    expect(saved.expiresAt).toBeNull();
    const sent = ok(await w.rep1.post(`/s/quotes/${q.id}/send`), 200, "send");
    expect(sent).toMatchObject({ expiresAt: when, workingExpiresAt: null });
    // Next revision without a chosen date defaults to +14 days from that send.
    ok(await w.rep1.post(`/s/quotes/${q.id}/claim`), 200, "claim again");
    w.advance(86400_000);
    const second = ok(await w.rep1.post(`/s/quotes/${q.id}/send`), 200, "send v2");
    expect(new Date(second.expiresAt).getTime()).toBe(w.clock.now.getTime() + 14 * 86400_000);
  });

  it("nextVersionNo is the N in 'Send vN': 1 before any send, and it keeps counting through accept, reopen and resend", async () => {
    const q = await submitted(w.dana);
    expect(ok(await w.rep1.get(`/s/quotes/${q.id}`), 200, "fresh")).toMatchObject({ currentVersion: 0, nextVersionNo: 1 });
    await claimAndPrice(w.rep1, q.id);
    const v1 = ok(await w.rep1.post(`/s/quotes/${q.id}/send`), 200, "send v1");
    expect(v1).toMatchObject({ currentVersion: 1, nextVersionNo: 2 });
    ok(await w.dana.post(`/c/quotes/${q.id}/accept`, { versionNo: 1 }), 200, "accept");
    const reopened = ok(await w.rep1.post(`/s/quotes/${q.id}/reopen`), 200, "staff reopen");
    expect(reopened).toMatchObject({ status: "IN_REVIEW", currentVersion: 1, nextVersionNo: 2 });
    const v2 = ok(await w.rep1.post(`/s/quotes/${q.id}/send`), 200, "send v2");
    expect(v2.currentVersion).toBe(reopened.nextVersionNo); // the version sent is the number the button promised
    expect(v2.nextVersionNo).toBe(3);
    ok(await w.dana.post(`/c/quotes/${q.id}/request-changes`, { message: "lower please" }), 200, "request changes");
    ok(await w.rep1.post(`/s/quotes/${q.id}/claim`), 200, "claim");
    const v3 = ok(await w.rep1.post(`/s/quotes/${q.id}/send`), 200, "send v3");
    expect(v3.versions.map((v: any) => v.versionNo)).toEqual([1, 2, 3]);
    expect(v3).toMatchObject({ currentVersion: 3, nextVersionNo: 4 });
    // Dealer-side reopen after accepting v3 also lands on 4, and a stale accept of the old version is refused.
    ok(await w.dana.post(`/c/quotes/${q.id}/accept`, { versionNo: 3 }), 200, "accept v3");
    ok(await w.dana.post(`/c/quotes/${q.id}/reopen`), 200, "dealer reopen");
    expect(ok(await w.rep1.get(`/s/quotes/${q.id}`), 200, "after dealer reopen").nextVersionNo).toBe(4);
    const v4 = ok(await w.rep1.post(`/s/quotes/${q.id}/send`), 200, "send v4");
    expect(v4.currentVersion).toBe(4);
    const stale = await w.dana.post(`/c/quotes/${q.id}/accept`, { versionNo: 3 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "VERSION_MISMATCH", details: { currentVersion: 4 } });
  });

  it("adding a variant through draft-revision snapshots the buyer's list price and the inventory cost, and returns margin and flags (no variant lookup route)", async () => {
    const q = await submitted(w.dana, [{ variantId: F.V_PIPE, qty: 1 }]);
    const claimed = await claimAndPrice(w.rep1, q.id);
    const keep = claimed.workingLines.map((l: any) => ({ id: l.id, variantId: l.variantId, qty: l.qty, quotedPrice: l.quotedPrice }));
    const saved = ok(
      await w.rep1.put(`/s/quotes/${q.id}/draft-revision`, { lines: [...keep, { variantId: F.V_VALVE, qty: 5, quotedPrice: "70.00", lineNote: "Brass" }, { variantId: F.V_THIN, qty: 1, quotedPrice: "100.00" }] }),
      200,
      "add products",
    );
    const valve = saved.workingLines.find((l: any) => l.variantId === F.V_VALVE);
    expect(valve).toMatchObject({ listPrice: "80.00", quotedPrice: "70.00", cost: F.COST.VALVE, costUnknown: false, belowFloor: false, lineNote: "Brass", addedBy: "STAFF", lineTotal: "350.00" });
    expect(valve.marginPct).toBeCloseTo(((70 - 23.19) / 70) * 100, 1);
    expect(saved.workingLines.find((l: any) => l.variantId === F.V_THIN)).toMatchObject({ cost: F.COST.THIN, belowFloor: true, costUnknown: false });
    expect(saved.belowFloor).toBe(true);
    // Another company is priced from its own catalog.
    const bq = await submitted(w.bea, [{ variantId: F.V_VALVE, qty: 1 }]);
    await claimAndPrice(w.rep1, bq.id);
    const cur = ok(await w.rep1.get(`/s/quotes/${bq.id}`), 200, "bea");
    const withPipe = ok(
      await w.rep1.put(`/s/quotes/${bq.id}/draft-revision`, { lines: [...cur.workingLines.map((l: any) => ({ id: l.id, variantId: l.variantId, qty: l.qty, quotedPrice: l.quotedPrice })), { variantId: F.V_PIPE, qty: 1, quotedPrice: "110.00" }] }),
      200,
      "bea pipe",
    );
    expect(withPipe.workingLines.find((l: any) => l.variantId === F.V_PIPE)).toMatchObject({ listPrice: "110.00", cost: F.COST.PIPE });
    // A variant that does not exist is a 422 and nothing changes; there is no /s/variants route.
    const ghost = await w.rep1.put(`/s/quotes/${bq.id}/draft-revision`, { lines: [{ variantId: F.V_GHOST, qty: 1, quotedPrice: "1.00" }] });
    expect(ghost.status).toBe(422);
    expect((await w.rep1.get(`/s/variants/${encodeURIComponent(F.V_PIPE)}`, { loose: true })).status).toBe(404);
    expect(ok(await w.rep1.get(`/s/quotes/${bq.id}`), 200, "unchanged").workingLines).toHaveLength(2);
  });

  it("staff attachments: upload-url, then a message that carries the file; foreign URLs and other quotes' files are refused; internal files never reach the dealer", async () => {
    const q = await submitted(w.dana);
    const up = ok(await w.rep1.post(`/s/quotes/${q.id}/attachments/upload-url`, { name: "spec sheet.pdf", size: 12345, mime: "application/pdf" }), 200, "upload url");
    expect(up.uploadUrl).toMatch(/^https:\/\//);
    expect(up.fileUrl).toContain(`/quotes/${q.id}/`);
    expect(new Date(up.expiresAt).getTime()).toBeGreaterThan(w.clock.now.getTime());
    const file = { url: up.fileUrl, name: "spec sheet.pdf", size: 12345, mime: "application/pdf" };
    const sent = ok(await w.rep1.post(`/s/quotes/${q.id}/messages`, { body: "Spec sheet attached", attachments: [file] }), 201, "message");
    expect(sent.attachments).toEqual([file]);
    expect(ok(await w.dana.get(`/c/quotes/${q.id}/messages`), 200, "dealer").items.at(-1).attachments).toEqual([file]);

    const other = await submitted(w.dana);
    const otherUp = ok(await w.rep1.post(`/s/quotes/${other.id}/attachments/upload-url`, { name: "x.pdf", size: 1, mime: "application/pdf" }), 200, "other");
    expect((await w.rep1.post(`/s/quotes/${q.id}/messages`, { body: "reuse", attachments: [{ ...file, url: otherUp.fileUrl }] })).status).toBe(422);
    expect((await w.rep1.post(`/s/quotes/${q.id}/messages`, { body: "evil", attachments: [{ ...file, url: "https://evil.example.test/x.pdf" }] })).status).toBe(422);

    const internal = ok(await w.rep1.post(`/s/quotes/${q.id}/messages`, { body: F.SECRET_INTERNAL_MSG, internal: true, attachments: [file] }), 201, "internal with file");
    expect(internal.internal).toBe(true);
    expect(JSON.stringify(ok(await w.dana.get(`/c/quotes/${q.id}`), 200, "dealer view")).includes(F.SECRET_INTERNAL_MSG)).toBe(false);

    expect((await w.rep1.post(`/s/quotes/${q.id}/attachments/upload-url`, { name: "big.bin", size: 26214401, mime: "application/octet-stream" }, { loose: true })).status).toBe(400);
    expect((await w.rep1.post(`/s/quotes/${q.id}/attachments/upload-url`, { name: "", size: 1, mime: "x/y" }, { loose: true })).status).toBe(400);
    expect((await w.rep1.post("/s/quotes/ghost/attachments/upload-url", { name: "a.pdf", size: 1, mime: "application/pdf" })).status).toBe(404);
  });
});

/** Re-save the working revision of a claimed quote with a chosen expiry (keeps lines as they are). */
async function claimAndPriceAgain(w: ReturnType<typeof useWorld>, quoteId: string, expiresAt: string) {
  const cur = ok(await w.rep1.get(`/s/quotes/${quoteId}`), 200, "load");
  const lines = cur.workingLines.map((l: any) => ({ id: l.id, variantId: l.variantId, qty: l.qty, quotedPrice: l.quotedPrice }));
  return ok(await w.rep1.put(`/s/quotes/${quoteId}/draft-revision`, { lines, expiresAt }), 200, "save with expiry");
}
