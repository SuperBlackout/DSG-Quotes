import { Prisma, type StaffRole } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import type { Schemas } from "shared";
import { z } from "zod";
import { isManagerRole, type AppDeps, type StaffPrincipal } from "../context";
import { D } from "../domain/money";
import { defaultFloor } from "../domain/lines";
import { ApiError, notFound } from "../errors";
import { parse } from "../http";

/**
 * Staff directory, teams, settings, saved replies and customer search (docs/openapi.yaml: /s/me, /s/staff, /s/teams,
 * /s/settings, /s/saved-replies, /s/customers). Registered inside `staffRoutes`, so they are served at /s/* and /api/s/*
 * behind the same admin-session-token hook. Writes need role manager or admin.
 */
const staffOf = (req: { staffPrincipal?: StaffPrincipal }) => req.staffPrincipal!.staff;

function requireManager(req: { staffPrincipal?: StaffPrincipal }, what: string) {
  if (!isManagerRole(staffOf(req).role)) throw new ApiError("FORBIDDEN", `Only a manager or admin can ${what}`);
}

const num = (d: Prisma.Decimal | null) => (d == null ? null : Number(d.toString()));
const pct = z.number().min(0).max(100);
const role = z.enum(["rep", "manager", "admin"]);

const staffListQuery = z.object({ active: z.enum(["true", "false"]).transform((v) => v === "true").optional() });
const updateStaffBody = z
  .object({ role, teamIds: z.array(z.string().min(1)).max(100), priceFloorPct: pct.nullable(), active: z.boolean() })
  .partial()
  .refine((o) => Object.keys(o).length > 0, "At least one field is required");
const teamBody = z.object({ name: z.string().trim().min(1).max(80), memberIds: z.array(z.string().min(1)).max(500).optional() });
const settingsBody = z.object({
  defaultPriceFloorPct: pct,
  routing: z.object({
    defaultTeamId: z.string().min(1).nullable().optional(),
    autoAssignByCompany: z.boolean(),
    rules: z
      .array(
        z.object({
          id: z.string().optional(),
          companyId: z.string().min(1).max(200),
          companyName: z.string().nullable().optional(), // read only: ignored when echoed back
          repId: z.string().min(1).nullable().optional(),
          teamId: z.string().min(1).nullable().optional(),
        }),
      )
      .max(500),
  }),
});
const savedRepliesBody = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1).optional(),
        title: z.string().trim().min(1).max(80),
        body: z.string().trim().min(1).max(5000),
        shared: z.boolean().default(false),
      }),
    )
    .max(100),
});
const customerQuery = z.object({
  q: z.string().trim().min(2).max(200),
  limit: z.coerce.number().int().min(1).default(25).transform((n) => Math.min(n, 100)),
});

export async function registerAdminRoutes(app: FastifyInstance, deps: AppDeps) {
  const shop = deps.config.shopDomain;
  const db = deps.prisma;

  const teamIdsByStaff = async (staffIds: string[]) => {
    const rows = await db.teamMember.findMany({ where: { staffId: { in: staffIds }, team: { shop } }, orderBy: { teamId: "asc" } });
    const map = new Map<string, string[]>(staffIds.map((id) => [id, []]));
    for (const r of rows) map.get(r.staffId)!.push(r.teamId);
    return map;
  };
  const staffMember = (s: { id: string; name: string; email: string; role: StaffRole; priceFloorPct: Prisma.Decimal | null; active: boolean }, teamIds: string[]): Schemas["StaffMember"] => ({
    id: s.id,
    name: s.name,
    email: s.email,
    role: s.role,
    teamIds,
    priceFloorPct: num(s.priceFloorPct),
    active: s.active,
  });
  const assertStaffExist = async (ids: string[], field: string) => {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return;
    const found = await db.staff.count({ where: { id: { in: unique }, shop } });
    if (found !== unique.length) throw new ApiError("VALIDATION_FAILED", "Unknown staff member", { field });
  };
  const assertTeamsExist = async (ids: string[], field: string) => {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return;
    const found = await db.team.count({ where: { id: { in: unique }, shop } });
    if (found !== unique.length) throw new ApiError("VALIDATION_FAILED", "Unknown team", { field });
  };

  // ---------------------------------------------------------------- me
  app.get("/me", async (req): Promise<Schemas["StaffMe"]> => {
    const me = staffOf(req);
    const teams = (await teamIdsByStaff([me.id])).get(me.id)!;
    const shopDefault = await defaultFloor(db, shop);
    return {
      id: me.id,
      name: me.name,
      email: me.email,
      role: me.role,
      teamIds: teams,
      priceFloorPct: num(me.priceFloorPct),
      effectivePriceFloorPct: Number((me.priceFloorPct ?? shopDefault).toString()),
      canApproveFloor: isManagerRole(me.role),
      canEditSettings: isManagerRole(me.role),
    };
  });

  // ---------------------------------------------------------------- staff
  app.get("/staff", async (req) => {
    const q = parse(staffListQuery, req.query);
    const rows = await db.staff.findMany({ where: { shop, ...(q.active !== undefined ? { active: q.active } : {}) }, orderBy: [{ name: "asc" }, { id: "asc" }] });
    const teams = await teamIdsByStaff(rows.map((r) => r.id));
    return { items: rows.map((r) => staffMember(r, teams.get(r.id)!)) };
  });

  app.put("/staff/:id", async (req) => {
    requireManager(req, "change staff settings");
    const me = staffOf(req);
    const { id } = req.params as { id: string };
    const body = parse(updateStaffBody, req.body);
    const target = await db.staff.findFirst({ where: { id, shop } });
    if (!target) throw notFound("Staff member");

    if ((body.role === "admin" || target.role === "admin") && body.role !== undefined && body.role !== target.role && me.role !== "admin") {
      throw new ApiError("FORBIDDEN", "Only an admin can grant or remove the admin role");
    }
    if (body.teamIds) await assertTeamsExist(body.teamIds, "teamIds");

    const nextRole = body.role ?? target.role;
    const nextActive = body.active ?? target.active;
    const wasPrivileged = target.active && isManagerRole(target.role);
    const willBePrivileged = nextActive && isManagerRole(nextRole);
    if (wasPrivileged && !willBePrivileged) {
      const others = await db.staff.count({ where: { shop, id: { not: id }, active: true, role: { in: ["manager", "admin"] } } });
      if (others === 0) throw new ApiError("BAD_REQUEST", "The shop must keep at least one active manager or admin");
    }

    const updated = await db.$transaction(async (tx) => {
      const row = await tx.staff.update({
        where: { id },
        data: {
          ...(body.role !== undefined ? { role: body.role } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
          ...(body.priceFloorPct !== undefined ? { priceFloorPct: body.priceFloorPct === null ? null : D(body.priceFloorPct).toDecimalPlaces(2) } : {}),
        },
      });
      if (body.teamIds) {
        await tx.teamMember.deleteMany({ where: { staffId: id } });
        await tx.teamMember.createMany({ data: [...new Set(body.teamIds)].map((teamId) => ({ teamId, staffId: id })) });
      }
      return row;
    });
    const teams = (await teamIdsByStaff([id])).get(id)!;
    return staffMember(updated, teams);
  });

  // ---------------------------------------------------------------- teams
  const teamView = async (id: string): Promise<Schemas["Team"]> => {
    const t = await db.team.findUniqueOrThrow({ where: { id }, include: { members: { orderBy: { staffId: "asc" } } } });
    return { id: t.id, name: t.name, memberIds: t.members.map((m) => m.staffId) };
  };

  app.get("/teams", async () => {
    const rows = await db.team.findMany({ where: { shop }, orderBy: [{ name: "asc" }, { id: "asc" }], include: { members: { orderBy: { staffId: "asc" } } } });
    return { items: rows.map((t) => ({ id: t.id, name: t.name, memberIds: t.members.map((m) => m.staffId) })) };
  });

  app.post("/teams", async (req, reply) => {
    requireManager(req, "create teams");
    const body = parse(teamBody, req.body);
    await assertStaffExist(body.memberIds ?? [], "memberIds");
    const team = await db.$transaction(async (tx) => {
      const t = await tx.team.create({ data: { shop, name: body.name } });
      if (body.memberIds?.length) await tx.teamMember.createMany({ data: [...new Set(body.memberIds)].map((staffId) => ({ teamId: t.id, staffId })) });
      return t;
    });
    return reply.status(201).send(await teamView(team.id));
  });

  app.put("/teams/:id", async (req) => {
    requireManager(req, "edit teams");
    const { id } = req.params as { id: string };
    const body = parse(teamBody, req.body);
    if (!(await db.team.findFirst({ where: { id, shop } }))) throw notFound("Team");
    await assertStaffExist(body.memberIds ?? [], "memberIds");
    await db.$transaction(async (tx) => {
      await tx.team.update({ where: { id }, data: { name: body.name } });
      if (body.memberIds) {
        await tx.teamMember.deleteMany({ where: { teamId: id } });
        await tx.teamMember.createMany({ data: [...new Set(body.memberIds)].map((staffId) => ({ teamId: id, staffId })) });
      }
    });
    return teamView(id);
  });

  app.delete("/teams/:id", async (req, reply) => {
    requireManager(req, "delete teams");
    const { id } = req.params as { id: string };
    if (!(await db.team.findFirst({ where: { id, shop } }))) throw notFound("Team");
    const settings = await db.shopSetting.findUnique({ where: { shop } });
    if (settings?.defaultTeamId === id) {
      throw new ApiError("BAD_REQUEST", "This team is the default routing team. Choose another default in settings before deleting it.", { field: "defaultTeamId" });
    }
    await db.$transaction(async (tx) => {
      // Quotes keep their rep but lose the team; routing rules that point at the team are removed.
      await tx.quote.updateMany({ where: { shop, teamId: id }, data: { teamId: null } });
      await tx.routingRule.deleteMany({ where: { shop, teamId: id } });
      await tx.team.delete({ where: { id } }); // memberships cascade
    });
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- settings
  const settingsView = async (): Promise<Schemas["StaffSettings"]> => {
    const [s, rules] = await Promise.all([
      db.shopSetting.findUnique({ where: { shop } }),
      db.routingRule.findMany({ where: { shop }, orderBy: [{ position: "asc" }, { id: "asc" }] }),
    ]);
    const names = rules.length
      ? await db.quote.findMany({
          where: { shop, companyId: { in: rules.map((r) => r.companyId) }, companyName: { not: null } },
          distinct: ["companyId"],
          orderBy: { createdAt: "desc" },
          select: { companyId: true, companyName: true },
        })
      : [];
    const nameOf = new Map(names.map((n) => [n.companyId, n.companyName]));
    return {
      defaultPriceFloorPct: Number((s?.defaultPriceFloorPct ?? D(15)).toString()),
      routing: {
        defaultTeamId: s?.defaultTeamId ?? null,
        autoAssignByCompany: s?.autoAssignByCompany ?? false,
        rules: rules.map((r) => ({ id: r.id, companyId: r.companyId, companyName: nameOf.get(r.companyId) ?? null, repId: r.repId, teamId: r.teamId })),
      },
    };
  };

  app.get("/settings", async () => settingsView());

  app.put("/settings", async (req) => {
    requireManager(req, "change settings");
    const body = parse(settingsBody, req.body);
    const { routing } = body;
    if (routing.defaultTeamId) await assertTeamsExist([routing.defaultTeamId], "routing.defaultTeamId");
    routing.rules.forEach((r, i) => {
      if (!r.repId && !r.teamId) throw new ApiError("VALIDATION_FAILED", "A routing rule needs a rep, a team or both", { field: `routing.rules.${i}` });
    });
    await assertStaffExist(routing.rules.flatMap((r) => (r.repId ? [r.repId] : [])), "routing.rules.repId");
    await assertTeamsExist(routing.rules.flatMap((r) => (r.teamId ? [r.teamId] : [])), "routing.rules.teamId");

    await db.$transaction(async (tx) => {
      const floor = D(body.defaultPriceFloorPct).toDecimalPlaces(2);
      await tx.shopSetting.upsert({
        where: { shop },
        create: { shop, defaultPriceFloorPct: floor, defaultTeamId: routing.defaultTeamId ?? null, autoAssignByCompany: routing.autoAssignByCompany },
        update: { defaultPriceFloorPct: floor, defaultTeamId: routing.defaultTeamId ?? null, autoAssignByCompany: routing.autoAssignByCompany },
      });
      const existing = new Set((await tx.routingRule.findMany({ where: { shop }, select: { id: true } })).map((r) => r.id));
      await tx.routingRule.deleteMany({ where: { shop } });
      await tx.routingRule.createMany({
        data: routing.rules.map((r, position) => ({
          ...(r.id && existing.has(r.id) ? { id: r.id } : {}),
          shop,
          companyId: r.companyId,
          repId: r.repId ?? null,
          teamId: r.teamId ?? null,
          position,
        })),
      });
    });
    return settingsView();
  });

  // ---------------------------------------------------------------- saved replies
  const repliesFor = async (staffId: string): Promise<Schemas["SavedReply"][]> => {
    const rows = await db.savedReply.findMany({
      where: { shop, OR: [{ shared: true }, { ownerId: staffId }] },
      orderBy: [{ shared: "desc" }, { position: "asc" }, { id: "asc" }],
    });
    return rows.map((r) => ({ id: r.id, title: r.title, body: r.body, shared: r.shared }));
  };

  app.get("/saved-replies", async (req) => ({ items: await repliesFor(staffOf(req).id) }));

  app.put("/saved-replies", async (req) => {
    const me = staffOf(req);
    const manager = isManagerRole(me.role);
    const { items } = parse(savedRepliesBody, req.body);
    if (!manager && items.some((i) => i.shared)) {
      throw new ApiError("FORBIDDEN", "Only a manager or admin can create or change shared replies");
    }
    await db.$transaction(async (tx) => {
      // The caller's replaceable set: their personal replies, plus the shared ones for managers and admins.
      const mine = await tx.savedReply.findMany({ where: { shop, OR: [{ ownerId: me.id, shared: false }, ...(manager ? [{ shared: true }] : [])] } });
      const byId = new Map(mine.map((r) => [r.id, r]));
      const keep = new Set<string>();
      for (const [position, it] of items.entries()) {
        if (it.id) {
          const cur = byId.get(it.id);
          if (!cur) throw new ApiError("VALIDATION_FAILED", "Unknown saved reply", { field: "items", id: it.id });
          if (keep.has(it.id)) throw new ApiError("VALIDATION_FAILED", "Duplicate saved reply id", { field: "items", id: it.id });
          keep.add(it.id);
          await tx.savedReply.update({
            where: { id: it.id },
            data: { title: it.title, body: it.body, shared: it.shared, ownerId: it.shared ? null : me.id, position },
          });
        } else {
          await tx.savedReply.create({ data: { shop, title: it.title, body: it.body, shared: it.shared, ownerId: it.shared ? null : me.id, position } });
        }
      }
      const drop = mine.filter((r) => !keep.has(r.id)).map((r) => r.id);
      if (drop.length) await tx.savedReply.deleteMany({ where: { id: { in: drop } } });
    });
    return { items: await repliesFor(me.id) };
  });

  // ---------------------------------------------------------------- customer search
  app.get("/customers", async (req) => {
    const q = parse(customerQuery, req.query);
    const found = await deps.shopify.searchCustomers(q.q, q.limit);
    const addr = (a: Record<string, string | null> | null): Schemas["Address"] | null => {
      if (!a) return null;
      const out: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(a)) if (v != null || k === "address2" || k === "phone") out[k] = v;
      return out as Schemas["Address"];
    };
    return {
      items: found.map((c): Schemas["StaffCustomer"] => ({
        customerId: c.customerId,
        name: c.name,
        email: c.email,
        phone: c.phone,
        companyId: c.companyId,
        companyName: c.companyName,
        locations: c.locations.map((l) => ({ companyLocationId: l.companyLocationId, name: l.name, shipTo: addr(l.shipTo) })),
      })),
    };
  });
}

