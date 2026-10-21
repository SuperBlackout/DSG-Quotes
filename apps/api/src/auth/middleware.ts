import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "../context";
import { ApiError } from "../errors";
import { verifyAppProxyRequest, verifySessionToken } from "./crypto";

const CUSTOMER_GID = "gid://shopify/Customer/";

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1]!.trim() : null;
}

/**
 * Identify the caller of a /c route and resolve their company buyer. Which credential is accepted depends on the mount:
 *  - `proxy` (/proxy/c/*, reached through the Shopify app proxy at /apps/quotes/c/*): app proxy query signature only
 *    (HMAC + freshness); customer = `logged_in_customer_id`.
 *  - `direct` (/c/*, the absolute origin https://quotes.dsg.direct/c/*): customer-account session token only
 *    (Bearer JWT); customer = `sub`. A `signature` query parameter is ignored there: the app proxy HMAC does not apply.
 * Never falls back from one credential to the other. The optional `X-Company-Location-Id` header picks
 * among the locations the contact already belongs to; anything else is ignored.
 */
export function customerAuth(deps: AppDeps, mode: "proxy" | "direct" = "direct") {
  return async function authenticateCustomer(req: FastifyRequest, _reply: FastifyReply) {
    const rawQuery = req.raw.url?.includes("?") ? req.raw.url.slice(req.raw.url.indexOf("?") + 1) : "";
    let customerId: string;

    if (mode === "proxy") {
      if (!new URLSearchParams(rawQuery).has("signature")) throw new ApiError("UNAUTHENTICATED", "Missing app proxy signature");
      const v = verifyAppProxyRequest(rawQuery, deps.config.apiSecret, {
        now: deps.now(),
        maxAgeSeconds: deps.config.signatureMaxAgeSeconds,
      });
      if (!v.ok) throw new ApiError("UNAUTHENTICATED", `Invalid app proxy signature (${v.reason})`);
      if (v.params.get("shop") !== deps.config.shopDomain) throw new ApiError("UNAUTHENTICATED", "Wrong shop");
      const id = v.params.get("logged_in_customer_id");
      if (!id) throw new ApiError("UNAUTHENTICATED", "Sign in to use quotes");
      customerId = CUSTOMER_GID + id;
    } else {
      const token = bearer(req);
      if (!token) throw new ApiError("UNAUTHENTICATED", "Missing credentials");
      const v = verifySessionToken(token, {
        secret: deps.config.apiSecret,
        audience: deps.config.apiKey,
        shopDomain: deps.config.shopDomain,
        now: deps.now(),
      });
      if (!v.ok) throw new ApiError("UNAUTHENTICATED", `Invalid session token (${v.reason})`);
      if (!v.claims.sub.startsWith(CUSTOMER_GID)) throw new ApiError("UNAUTHENTICATED", "Not a customer token");
      customerId = v.claims.sub;
    }

    const pref = req.headers["x-company-location-id"];
    const buyer = await deps.shopify.resolveBuyer(customerId, typeof pref === "string" ? pref : null);
    if (!buyer) throw new ApiError("FORBIDDEN", "A company account is required to use quotes");
    // Defence in depth: the gateway must never hand back a location the contact does not belong to.
    if (!buyer.locations.some((l) => l.id === buyer.companyLocationId)) {
      throw new ApiError("FORBIDDEN", "Company location not permitted");
    }
    req.customer = { kind: "customer", buyer };
  };
}

/** Shopify admin session token (embedded app) -> Staff row (auto-provisioned on first sight). */
export function staffAuth(deps: AppDeps) {
  return async function authenticateStaff(req: FastifyRequest, _reply: FastifyReply) {
    const token = bearer(req);
    if (!token) throw new ApiError("UNAUTHENTICATED", "Missing credentials");
    const v = verifySessionToken(token, {
      secret: deps.config.apiSecret,
      audience: deps.config.apiKey,
      shopDomain: deps.config.shopDomain,
      now: deps.now(),
    });
    if (!v.ok) throw new ApiError("UNAUTHENTICATED", `Invalid session token (${v.reason})`);
    // Customer-account tokens (sub = customer gid) must never open staff routes.
    if (v.claims.sub.startsWith("gid://")) throw new ApiError("FORBIDDEN", "Not a staff token");
    const shop = deps.config.shopDomain;
    let staff = await deps.prisma.staff.findUnique({ where: { shop_shopifyStaffId: { shop, shopifyStaffId: v.claims.sub } } });
    if (!staff) {
      // Bootstrap: the first staff member to open the app in a shop becomes its admin (someone has to be able to promote the
      // others in Settings); everyone after that starts as a rep.
      const hasManager = (await deps.prisma.staff.count({ where: { shop, active: true, role: { in: ["manager", "admin"] } } })) > 0;
      staff = await deps.prisma.staff.upsert({
        where: { shop_shopifyStaffId: { shop, shopifyStaffId: v.claims.sub } },
        create: {
          shop,
          shopifyStaffId: v.claims.sub,
          name: `Staff ${v.claims.sub}`,
          email: `staff-${v.claims.sub}@users.invalid`,
          role: hasManager ? "rep" : "admin",
        },
        update: {},
      });
    }
    if (!staff.active) throw new ApiError("FORBIDDEN", "This staff account has been deactivated");
    req.staffPrincipal = {
      kind: "staff",
      staff: {
        id: staff.id,
        name: staff.name,
        email: staff.email,
        role: staff.role,
        priceFloorPct: staff.priceFloorPct,
        shopifyStaffId: staff.shopifyStaffId,
      },
    };
  };
}
