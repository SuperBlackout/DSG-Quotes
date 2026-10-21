import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Schemas } from "shared";
import type { AppDeps } from "../context";
import { ApiError } from "../errors";
import { parse } from "../http";
import { asEmails } from "../serializers/customer";
import type { BuyerContext } from "../shopify/types";

/** Events a customer can configure (docs/openapi.yaml NotificationPrefs.events). Defaults: email on, SMS off. */
export const PREF_EVENTS = ["QUOTE_READY", "NEW_MESSAGE", "CHANGES_REQUESTED", "ACCEPTED", "ORDERED", "EXPIRING"] as const;

const E164 = /^\+[1-9]\d{7,14}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const prefsBody = z.object({
  events: z.record(z.string().regex(/^[A-Z_]{2,40}$/), z.object({ email: z.boolean(), sms: z.boolean() })),
  email: z.string().email(),
  phone: z.string().nullable().optional(),
  smsOptIn: z.boolean().optional(),
  smsConsentText: z.string().max(2000).optional(),
  quietStart: z.string().regex(HHMM).nullable().optional(),
  quietEnd: z.string().regex(HHMM).nullable().optional(),
  timezone: z.string().min(1).max(64).optional(),
  watchers: z.array(z.string().email()).max(20).optional(),
});

async function view(deps: AppDeps, buyer: BuyerContext): Promise<Schemas["NotificationPrefs"]> {
  const shop = deps.config.shopDomain;
  const [rows, profile] = await Promise.all([
    deps.prisma.notificationPref.findMany({ where: { shop, customerId: buyer.customerId }, orderBy: { event: "asc" } }),
    deps.prisma.customerProfile.findUnique({ where: { shop_customerId: { shop, customerId: buyer.customerId } } }),
  ]);
  const events: Record<string, { email: boolean; sms: boolean }> = {};
  if (rows.length === 0) for (const e of PREF_EVENTS) events[e] = { email: true, sms: false };
  for (const r of rows) events[r.event] = { email: r.email, sms: r.sms };
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
    watchers: asEmails(profile?.watchers),
  };
}

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

    await deps.prisma.$transaction(async (tx) => {
      const existing = await tx.notificationPref.findFirst({ where: { shop, customerId: buyer.customerId, smsOptInAt: { not: null } } });
      // Keep the ORIGINAL consent timestamp + wording while the customer stays opted in.
      const smsOptInAt = optIn ? (existing?.smsOptInAt ?? deps.now()) : null;
      const consent = optIn ? (existing?.smsConsentText ?? body.smsConsentText!.trim()) : null;
      await tx.notificationPref.deleteMany({ where: { shop, customerId: buyer.customerId } });
      await tx.notificationPref.createMany({
        data: Object.entries(body.events).map(([event, v]) => ({
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
        create: { shop, customerId: buyer.customerId, email: body.email, watchers: body.watchers ?? [] },
        update: { email: body.email, ...(body.watchers ? { watchers: body.watchers } : {}) },
      });
    });
    return view(deps, buyer);
  });
}
