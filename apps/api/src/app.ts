import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { AppDeps } from "./context";
import { ApiError } from "./errors";
import { customerRoutes } from "./routes/customer";
import { staffRoutes } from "./routes/staff";
import { webhookRoutes } from "./routes/webhooks";

/**
 * Fastify service (chosen over mounting inside the React Router app: the API has its own lifecycle, raw-body
 * webhook handling and test harness; Render runs it as `pnpm -F api start` on dsg-quotes-web).
 *
 * Route prefixes:
 *   /c/*, /proxy/c/*      customer routes (app proxy forwards /apps/quotes/* to <APP_URL>/proxy/*)
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

  // CORS for the customer-account extension, which calls /c/* cross-origin from Shopify's extension sandbox with
  // a Bearer session token (no cookies, so a wildcard origin does not expose ambient credentials).
  // Staff routes are same-origin from the embedded app and get no CORS headers.
  const isCustomerPath = (url: string) => /^\/(proxy\/)?c\//.test(url);
  app.addHook("onRequest", async (req, reply) => {
    if (!isCustomerPath(req.raw.url ?? "")) return;
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-allow-headers", "authorization, content-type, x-company-location-id");
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

  await app.register(customerRoutes, { prefix: "/c" });
  await app.register(customerRoutes, { prefix: "/proxy/c" });
  await app.register(staffRoutes, { prefix: "/s" });
  await app.register(staffRoutes, { prefix: "/api/s" });
  await app.register(webhookRoutes, { prefix: "/webhooks" });

  return app;
}
