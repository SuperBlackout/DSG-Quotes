import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AccountInfo, ActivityPage, DocKind, HttpError, PdfLink, StatementSummary,
  type Buyer,
} from "@dsg/contracts";
import { PdfLinkService, StatementService, writeAudit } from "@dsg/statement";
import { parseWebhook, verifyZohoWebhook } from "@dsg/statement";
import { readCompanyProfile } from "@dsg/identity";
import type { StatementDeps } from "./deps";

/**
 * Account pages API for the customer-account extensions (account-statement, account-info).
 *   GET  /a/v1/statement/summary      balances, overdue, credit  (Zoho cache)
 *   GET  /a/v1/statement/activity     invoices / payments / credits / sales orders, filters + cursor
 *   POST /a/v1/statement/pdf-link     single-use link to a Zoho statement PDF
 *   POST /a/v1/invoices/:id/pdf-link  single-use link to one invoice PDF
 *   GET  /a/v1/account                company profile (Shopify) + terms/credit (Zoho cache)
 *   GET  /a/files/:token              single-use PDF download (the token is the capability)
 *   POST /webhooks/zoho               Zoho change signal -> debounced re-sync (HMAC)
 * Identity is ONLY the verified Shopify customer-account session token -> company -> account_map; nothing the client
 * sends (query, body, params) is ever used to choose whose data is returned. Not part of docs/openapi.yaml (that
 * contract covers /c and /s); documented in docs/ACCOUNT-PAGES.md.
 */

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), "invalid date");
const ActivityQueryIn = z.object({
  type: DocKind.optional(),
  from: ISO_DATE.optional(),
  to: ISO_DATE.optional(),
  cursor: z.string().min(1).max(512).optional(),
  search: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const StatementPdfIn = z.object({ from: ISO_DATE.optional(), to: ISO_DATE.optional() }).default({});
const DocIdParam = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });
const TokenParam = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,128}$/) });

const GENERIC: Record<number, string> = {
  400: "Bad request", 401: "Unauthorized", 403: "Forbidden", 404: "Not found", 413: "Payload too large",
  415: "Unsupported media type", 429: "Too many requests", 503: "Service unavailable",
};
const MAX_STATEMENT_DAYS = 366 * 3;

function parseOr400<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(400, "Bad request");
  return r.data;
}
function out<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error("response failed contract validation");
  return r.data;
}

declare module "fastify" {
  interface FastifyRequest { buyer?: Buyer }
}

/** Generic error bodies only ({ error }): the extensions map by status code, never by message. */
function install(app: FastifyInstance) {
  app.setErrorHandler((err: any, req, reply) => {
    let status = 500;
    if (err instanceof HttpError) status = err.status;
    else if (err?.statusCode >= 400 && err.statusCode < 500) status = err.statusCode;
    if (status >= 500 && status !== 503) req.log.error({ err: { name: err?.name, message: String(err?.message ?? "").slice(0, 200) } }, "statement request failed");
    return reply.code(status).send({ error: GENERIC[status] ?? (status >= 500 ? "Internal error" : "Bad request") });
  });
}

export async function statementRoutes(app: FastifyInstance, opts: { statement: StatementDeps; now: () => Date }) {
  const deps = opts.statement;
  const now = opts.now;
  install(app);
  const statements = new StatementService(deps.pool, now);
  const links = new PdfLinkService(deps.pool);
  const rl = deps.rateLimit ?? { max: 60, windowMs: 60_000 };
  const base = deps.publicBaseUrl.replace(/\/+$/, "");

  app.addHook("onRequest", async (_req, reply) => {
    reply.header("x-content-type-options", "nosniff")
      .header("x-frame-options", "DENY")
      .header("referrer-policy", "no-referrer")
      .header("content-security-policy", "default-src 'none'; frame-ancestors 'none'")
      .header("cache-control", "no-store");
  });

  // ---- buyer-facing JSON API
  await app.register(async (v1) => {
    const hits = new Map<string, { n: number; reset: number }>();
    const limited = (key: string): boolean => {
      const t = now().getTime();
      if (hits.size > 5000) for (const [k, h] of hits) if (h.reset <= t) hits.delete(k);
      const h = hits.get(key);
      if (!h || h.reset <= t) { hits.set(key, { n: 1, reset: t + rl.windowMs }); return false; }
      h.n++;
      return h.n > rl.max;
    };
    const audit = (b: Buyer | null, action: string, outcome: string) =>
      writeAudit(deps.pool, { shopifyCompanyId: b?.shopifyCompanyId, zohoCustomerId: b?.zohoCustomerId, action, outcome });

    v1.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.method === "OPTIONS") return; // preflight is answered by the app-level CORS hook
      const action = `${req.method} ${req.routeOptions?.url ?? "unmatched"}`;
      let buyer: Buyer;
      try {
        buyer = await deps.resolver.resolve(req.headers.authorization);
      } catch (e) {
        if (e instanceof HttpError && e.status === 403) await audit(null, action, "denied").catch(() => {});
        throw e;
      }
      req.buyer = buyer;
      if (limited(buyer.shopifyCustomerId)) {
        await audit(buyer, action, "rate_limited").catch(() => {});
        reply.header("retry-after", String(Math.ceil(rl.windowMs / 1000)));
        throw new HttpError(429, "Too many requests");
      }
    });
    const buyerOf = (req: FastifyRequest): Buyer => { if (!req.buyer) throw new HttpError(401, "Unauthorized"); return req.buyer; };

    v1.get("/v1/statement/summary", async (req) => {
      const b = buyerOf(req);
      const s = await statements.getSummary(b.zohoCustomerId);
      if (!s) {
        await audit(b, "statement.summary", "not_synced");
        void deps.queue.enqueueSync(b.zohoCustomerId).catch(() => {});
        throw new HttpError(503, "Service unavailable");
      }
      await audit(b, "statement.summary", "ok");
      return out(StatementSummary, s);
    });

    v1.get("/v1/statement/activity", async (req) => {
      const b = buyerOf(req);
      const q = parseOr400(ActivityQueryIn, req.query);
      if (q.from && q.to && q.from > q.to) throw new HttpError(400, "Bad request");
      const page = await statements.listActivity(b.zohoCustomerId, { kind: q.type, from: q.from, to: q.to, cursor: q.cursor, limit: q.limit, search: q.search });
      await audit(b, "statement.activity", "ok");
      return out(ActivityPage, page);
    });

    v1.post("/v1/statement/pdf-link", async (req) => {
      const b = buyerOf(req);
      const body = parseOr400(StatementPdfIn, req.body ?? {});
      const today = now().toISOString().slice(0, 10);
      const to = body.to ?? today;
      const from = body.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 365 * 86400_000).toISOString().slice(0, 10);
      const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000;
      if (from > to || days > MAX_STATEMENT_DAYS) throw new HttpError(400, "Bad request");
      const { token, expiresAt } = await links.create(b.zohoCustomerId, "statement", `${from}|${to}`);
      await audit(b, "statement.pdf_link", "ok");
      return out(PdfLink, { url: `${base}/a/files/${token}`, expiresAt });
    });

    v1.post("/v1/invoices/:id/pdf-link", async (req) => {
      const b = buyerOf(req);
      const { id } = parseOr400(DocIdParam, req.params);
      const { rows } = await deps.pool.query(
        `select 1 from zoho_document where id = $1 and zoho_customer_id = $2 and kind = 'invoice' and source = 'zoho'`,
        [id, b.zohoCustomerId]);
      if (!rows.length) { await audit(b, "invoice.pdf_link", "not_found"); throw new HttpError(404, "Not found"); }
      const { token, expiresAt } = await links.create(b.zohoCustomerId, "invoice", id);
      await audit(b, "invoice.pdf_link", "ok");
      return out(PdfLink, { url: `${base}/a/files/${token}`, expiresAt });
    });

    v1.get("/v1/account", async (req) => {
      const b = buyerOf(req);
      // The company id comes from the verified buyer (token -> Shopify), never from the request.
      const profile = await readCompanyProfile(deps.admin, b.shopifyCompanyId);
      const sum = await statements.getSummary(b.zohoCustomerId); // null until the first sync: Zoho fields are then null
      await audit(b, "account.info", "ok");
      return out(AccountInfo, {
        companyName: profile.name,
        customerNumber: b.customerNumber,
        currency: sum?.currency ?? null,
        paymentTerms: sum?.paymentTerms ?? null,
        creditLimit: sum?.creditLimit ?? null,
        zohoAsOf: sum?.asOf ?? null,
        locations: profile.locations,
        contacts: profile.contacts,
      });
    });
  }, { prefix: "" });

  // ---- single-use PDF download (the token is the capability; no auth header)
  app.get("/files/:token", async (req, reply) => {
    const tp = TokenParam.safeParse(req.params);
    if (!tp.success) throw new HttpError(404, "Not found");
    const token = tp.data.token;
    const link = await links.redeem(token);
    if (!link) throw new HttpError(404, "Not found");
    const who = { zohoCustomerId: link.zohoCustomerId };
    let bytes: Uint8Array; let filename: string;
    // The atomic redeem keeps single use under races; if Zoho fails the token is handed back so a 5xx / timeout /
    // link-scanner hit does not burn it. After the bytes are in hand it stays used.
    const giveBack = async () => { await links.release(token).catch(() => {}); };
    const fetchPdf = async (f: () => Promise<Uint8Array>) => {
      try { return await f(); } catch { await giveBack(); throw new HttpError(503, "Service unavailable"); }
    };
    if (link.docKind === "invoice" && link.docId) {
      const { rows } = await deps.pool.query(
        `select number from zoho_document where id = $1 and zoho_customer_id = $2 and kind = 'invoice'`,
        [link.docId, link.zohoCustomerId]);
      if (!rows.length) { await writeAudit(deps.pool, { ...who, action: "file.download", outcome: "not_found" }); throw new HttpError(404, "Not found"); }
      filename = `invoice-${String(rows[0].number).replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
      bytes = await fetchPdf(() => deps.zoho.getInvoicePdf(link.docId!));
    } else if (link.docKind === "statement" && link.docId && /^\d{4}-\d{2}-\d{2}\|\d{4}-\d{2}-\d{2}$/.test(link.docId)) {
      const [from, to] = link.docId.split("|") as [string, string];
      filename = `statement-${from}-to-${to}.pdf`;
      bytes = await fetchPdf(() => deps.zoho.getStatementPdf(link.zohoCustomerId, from, to));
    } else {
      throw new HttpError(404, "Not found");
    }
    await writeAudit(deps.pool, { ...who, action: "file.download", outcome: "ok" });
    // The default CSP (default-src 'none') can stop Chrome's built-in PDF viewer from rendering an inline PDF, so this
    // one response gets a PDF-appropriate policy. Still application/pdf + nosniff; framing stays denied.
    return reply.type("application/pdf")
      .header("content-security-policy", "frame-ancestors 'none'")
      .header("content-disposition", `inline; filename="${filename}"`)
      .header("cache-control", "no-store")
      .send(Buffer.from(bytes));
  });
}

/** POST /webhooks/zoho (outside /a: same prefix as the Shopify webhooks). Raw body for the HMAC. */
export async function zohoWebhookRoutes(app: FastifyInstance, opts: { statement: StatementDeps }) {
  const deps = opts.statement;
  install(app);
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 256 * 1024 }, (_r, body, done) => done(null, body));
  app.post("/zoho", async (req, reply) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyZohoWebhook(req.headers, raw, deps.webhookSecret ?? "")) throw new HttpError(401, "Unauthorized");
    try {
      const id = await parseWebhook(deps.pool, raw.toString("utf8"));
      if (id) await deps.queue.enqueueSync(id);
    } catch { /* never let a bad payload or queue hiccup turn into a retry storm */ }
    return reply.code(200).send({ ok: true });
  });
}
