import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Schemas } from "shared";
import type { AppDeps } from "../context";
import { ApiError } from "../errors";
import { parse } from "../http";
import type { BuyerContext } from "../shopify/types";

/**
 * The seven customer notification keys, exactly (docs/openapi.yaml NotificationEvent / NotificationPrefs.events).
 * Defaults: email on, SMS off. CHANGES_REQUESTED is staff-only and is NOT a customer preference.
 * The worker maps quote events onto these keys (SUBMIT -> QUOTE_RECEIVED, SEND_REVISION -> QUOTE_READY, staff message ->
 * NEW_MESSAGE, 3-day reminder -> EXPIRING, ORDER_PLACED -> ORDERED, ACCEPT -> ACCEPTED, weekly digest -> WEEKLY_SUMMARY).
 */
export const PREF_EVENTS = ["QUOTE_RECEIVED", "QUOTE_READY", "NEW_MESSAGE", "EXPIRING", "ORDERED", "ACCEPTED", "WEEKLY_SUMMARY"] as const;
export type PrefEvent = (typeof PREF_EVENTS)[number];

const E164 = /^\+[1-9]\d{7,14}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const channelPref = z.object({ email: z.boolean(), sms: z.boolean() }).strict();
// All seven keys are required on PUT and unknown keys are rejected.
const eventsShape = Object.fromEntries(PREF_EVENTS.map((e) => [e, channelPref])) as Record<PrefEvent, typeof channelPref>;
const watcherBody = z
  .object({
    email: z.string().email().max(254),
    name: z.string().max(200).nullable().optional(),
    role: z.string().max(200).nullable().optional(),
    scope: z.string().min(1).max(200), // "all" or a job id
    channels: channelPref,
  })
  .strict();

const prefsBody = z.object({
  events: z.object(eventsShape).strict(),
  email: z.string().email(),
  phone: z.string().nullable().optional(),
  smsOptIn: z.boolean().optional(),
  smsConsentText: z.string().max(2000).optional(),
  quietStart: z.string().regex(HHMM).nullable().optional(),
  quietEnd: z.string().regex(HHMM).nullable().optional(),
  timezone: z.string().min(1).max(64).optional(),
  watchers: z.array(watcherBody).max(20).optional(),
});

/** Stored watchers may still be plain emails from before contract 0.2.0: read them as "all quotes, email only". */
function asWatchers(v: unknown): Schemas["Watcher"][] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((w): Schemas["Watcher"][] => {
    if (typeof w === "string") return [{ email: w, name: null, role: null, scope: "all", channels: { email: true, sms: false } }];
    if (!w || typeof w !== "object") return [];
    const o = w as Record<string, unknown>;
    if (typeof o.email !== "string") return [];
    const ch = (o.channels ?? {}) as Record<string, unknown>;
    return [
      {
        email: o.email,
        name: typeof o.name === "string" ? o.name : null,
        role: typeof o.role === "string" ? o.role : null,
        scope: typeof o.scope === "string" ? o.scope : "all",
        channels: { email: ch.email !== false, sms: ch.sms === true },
      },
    ];
  });
}

async function view(deps: AppDeps, buyer: BuyerContext): Promise<Schemas["NotificationPrefs"]> {
  const shop = deps.config.shopDomain;
  const [rows, profile] = await Promise.all([
    deps.prisma.notificationPref.findMany({ where: { shop, customerId: buyer.customerId }, orderBy: { event: "asc" } }),
    deps.prisma.customerProfile.findUnique({ where: { shop_customerId: { shop, customerId: buyer.customerId } } }),
  ]);
  const events = Object.fromEntries(PREF_EVENTS.map((e) => [e, { email: true, sms: false }])) as Schemas["NotificationPrefs"]["events"];
  for (const r of rows) if ((PREF_EVENTS as readonly string[]).includes(r.event)) events[r.event as PrefEvent] = { email: r.email, sms: r.sms };
  const first = rows[0];
  return {
    events,
    email: profile?.email ?? buyer.email ?? "",
    phone: first?.phone ?? null,
    smsOptIn: !!first?.smsOptInAt,
    smsConsentText: first?.smsConsentText ?? undefined,
    smsOptInAt: first?.smsOptInAt ? first.smsOptInAt.toISOString() : null,
    quietStart: first?.quietStart ?? null,
    quietEnd: first?.quietEnd ?? null,
    timezone: first?.timezone ?? "America/New_York",
    watchers: asWatchers(profile?.watchers),
  };
}

const normalizeWatchers = (ws: z.infer<typeof watcherBody>[] | undefined) =>
  (ws ?? []).map((w) => ({ email: w.email.trim().toLowerCase(), name: w.name ?? null, role: w.role ?? null, scope: w.scope, channels: w.channels }));

export async function registerPrefsRoutes(app: FastifyInstance, deps: AppDeps) {
  app.get("/notification-prefs", async (req) => view(deps, req.customer!.buyer));

  app.put("/notification-prefs", async (req) => {
    const buyer = req.customer!.buyer;
    const body = parse(prefsBody, req.body);
    const shop = deps.config.shopDomain;
    const optIn = body.smsOptIn === true;
    const anySms = Object.values(body.events).some((e) => e.sms);

    if (anySms && !optIn) throw new ApiError("VALIDATION_FAILED", "SMS opt-in is required before enabling text alerts", { field: "smsOptIn" });
    if (optIn) {
      if (!body.phone || !E164.test(body.phone)) throw new ApiError("VALIDATION_FAILED", "Enter a mobile number like +13125550123", { field: "phone" });
      if (!body.smsConsentText?.trim()) throw new ApiError("VALIDATION_FAILED", "The consent text shown to the customer must be recorded", { field: "smsConsentText" });
    }

    if (optIn && body.phone) {
      const blocked = await deps.prisma.smsOptOut.findUnique({ where: { phone: body.phone } });
      if (blocked) throw new ApiError("VALIDATION_FAILED", "This number opted out. Text START to our number first, then try again.", { field: "phone" });
    }

    // A watcher's scope is "all" or one of THIS company's jobs; never another company's.
    const jobScopes = [...new Set((body.watchers ?? []).map((w) => w.scope).filter((x) => x !== "all"))];
    if (jobScopes.length) {
      const ok = await deps.prisma.job.findMany({ where: { id: { in: jobScopes }, shop, companyId: buyer.companyId }, select: { id: true } });
      const known = new Set(ok.map((j) => j.id));
      const bad = jobScopes.filter((j) => !known.has(j));
      if (bad.length) throw new ApiError("VALIDATION_FAILED", "Watcher scope must be \"all\" or one of your company's jobs", { field: "watchers", scopes: bad });
    }

    await deps.prisma.$transaction(async (tx) => {
      const existing = await tx.notificationPref.findFirst({ where: { shop, customerId: buyer.customerId, smsOptInAt: { not: null } } });
      // Keep the ORIGINAL consent timestamp + wording while the customer stays opted in.
      const smsOptInAt = optIn ? (existing?.smsOptInAt ?? deps.now()) : null;
      const consent = optIn ? (existing?.smsConsentText ?? body.smsConsentText!.trim()) : null;
      await tx.notificationPref.deleteMany({ where: { shop, customerId: buyer.customerId } });
      await tx.notificationPref.createMany({
        data: PREF_EVENTS.map((event) => [event, body.events[event]] as const).map(([event, v]) => ({
          shop,
          customerId: buyer.customerId,
          event,
          email: v.email,
          sms: optIn && v.sms,
          phone: body.phone ?? null,
          smsOptInAt,
          smsConsentText: consent,
          quietStart: body.quietStart ?? null,
          quietEnd: body.quietEnd ?? null,
          timezone: body.timezone ?? "America/New_York",
        })),
      });
      await tx.customerProfile.upsert({
        where: { shop_customerId: { shop, customerId: buyer.customerId } },
        create: { shop, customerId: buyer.customerId, email: body.email, watchers: normalizeWatchers(body.watchers) },
        update: { email: body.email, ...(body.watchers ? { watchers: normalizeWatchers(body.watchers) } : {}) },
      });
    });
    return view(deps, buyer);
  });
}
