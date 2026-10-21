import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { AppDeps } from "./context";
import { ApiError } from "./errors";
import { hookOptionsFromEnv, hookRoutes, hooksEnabled } from "./hooks";
import { customerRoutes } from "./routes/customer";
import { staffRoutes } from "./routes/staff";
import { webhookRoutes } from "./routes/webhooks";

/**
 * Fastify service (chosen over mounting inside the React Router app: the API has its own lifecycle, raw-body
 * webhook handling and test harness; Render runs it as `pnpm -F api start` on dsg-quotes-web).
 *
 * Route prefixes:
 *   /c/*                  customer routes on the absolute origin (customer-account session token, CORS)
 *   /proxy/c/*            the same routes through the Shopify app proxy (forwards /apps/quotes/* to <APP_URL>/proxy/*; HMAC signature)
 *   /s/*, /api/s/*        staff routes (embedded admin app; openapi server "/api")
 *   /webhooks/shopify     Shopify webhooks (HMAC verified)
 *   /healthz              liveness + DB check
 */
export interface BuildOptions {
  logger?: boolean;
  /** Test hooks: observe every registered route / every handled request (route-coverage test). */
  onRoute?: (method: string, url: string) => void;
  onResponse?: (method: string, routeUrl: string, status: number) => void;
  /** Test only: add an `x-route-pattern` header so tests can validate bodies against docs/openapi.yaml. */
  exposeRoute?: boolean;
}

export async function buildApp(deps: AppDeps, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1_000_000, trustProxy: true });
  app.decorate("deps", deps);

  if (opts.onRoute) {
    app.addHook("onRoute", (r) => {
      for (const m of ([] as string[]).concat(r.method)) opts.onRoute!(m, r.url);
    });
  }
  if (opts.onResponse) {
    app.addHook("onResponse", async (req, reply) => {
      opts.onResponse!(req.method, req.routeOptions.url ?? req.url, reply.statusCode);
    });
  }

  // CORS for the customer-account extension (docs/openapi.yaml info.x-cors). It calls /c/* cross-origin from Shopify's
  // sandbox with a Bearer session token and no cookies, so echoing the request Origin (including the literal "null" that
  // sandboxed iframes and workers send) does not expose ambient credentials; Access-Control-Allow-Credentials is never sent.
  // Every /c/* path answers an OPTIONS preflight with 204 and no authentication. /s/*, /hooks/* and the app proxy mount
  // (/proxy/c/*, same-origin storefront) get no CORS headers.
  const isDirectCustomerPath = (url: string) => /^\/c(\/|\?|$)/.test(url);
  app.addHook("onRequest", async (req, reply) => {
    if (!isDirectCustomerPath(req.raw.url ?? "")) return;
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin) reply.header("access-control-allow-origin", origin);
    reply.header("vary", "Origin");
    reply.header("access-control-allow-headers", "Authorization, Content-Type");
    reply.header("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    reply.header("access-control-max-age", "600");
    if (req.method === "OPTIONS") return reply.status(204).send();
  });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("cache-control", "no-store");
    if (opts.exposeRoute) reply.header("x-route-pattern", reply.request.routeOptions.url ?? "");
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return reply.status(err.httpStatus).send(err.toBody());
    if (err instanceof ZodError) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Invalid request", details: { issues: err.issues } });
    }
    // Safety nets: input the route guards missed must still be a 4xx, never a 500 (QA found these on live-like data).
    const dbMsg = String((err as { message?: unknown }).message ?? "");
    if ((err as { code?: string }).code === "P2020" || /\b22003\b|numeric field overflow|out of range for type/i.test(dbMsg)) {
      return reply.status(422).send({ code: "VALIDATION_FAILED", message: "A number in the request is too large" });
    }
    if ((err as { name?: string }).name === "PrismaClientValidationError" && /Invalid value|Provided Date object is invalid/i.test(dbMsg)) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "Invalid value in request" });
    }
    const fe = err as { statusCode?: number; code?: string; message: string };
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      const code = fe.statusCode === 429 ? "RATE_LIMITED" : "BAD_REQUEST";
      return reply.status(fe.statusCode).send({ code, message: fe.message });
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ code: "INTERNAL", message: "Something went wrong" });
  });

  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ code: "NOT_FOUND", message: "Route not found" }));

  app.get("/healthz", async (_req, reply) => {
    try {
      await deps.prisma.$queryRaw`SELECT 1`;
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });

  await app.register(customerRoutes, { prefix: "/c", mode: "direct" });
  await app.register(customerRoutes, { prefix: "/proxy/c", mode: "proxy" });
  await app.register(staffRoutes, { prefix: "/s" });
  await app.register(staffRoutes, { prefix: "/api/s" });
  await app.register(webhookRoutes, { prefix: "/webhooks" });
  if (hooksEnabled()) await app.register(hookRoutes, { prefix: "/hooks", ...hookOptionsFromEnv(deps.config.apiSecret) });

  return app;
}
