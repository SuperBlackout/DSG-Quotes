import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const doc = parse(readFileSync(resolve(__dirname, "../../../docs/openapi.yaml"), "utf8")) as any;
const S = doc.components.schemas;
const EVENTS = ["QUOTE_RECEIVED", "QUOTE_READY", "NEW_MESSAGE", "EXPIRING", "ORDERED", "ACCEPTED", "WEEKLY_SUMMARY"];

describe("revision 0.2.0 / customer-account", () => {
  it("serves /c/* on an absolute HTTPS origin defaulting to quotes.dsg.direct", () => {
    const server = doc.servers.find((s: any) => String(s.url).startsWith("https://"));
    expect(server).toBeTruthy();
    expect(server.variables.host.default).toBe("quotes.dsg.direct");
  });

  it("documents CORS: null origin, Authorization header, OPTIONS preflight", () => {
    const cors = doc.info["x-cors"];
    expect(cors.allowedOrigins).toMatch(/null/);
    expect(cors.allowedHeaders).toContain("Authorization");
    expect(cors.allowedMethods).toContain("OPTIONS");
    expect(cors.preflight).toMatch(/OPTIONS/);
    expect(doc.info.description).toMatch(/session token/);
  });

  it("CustomerQuoteSummary has assignedRepName, unreadCount, previousTotal, currencyCode", () => {
    const p = S.CustomerQuoteSummary.properties;
    for (const k of ["assignedRepName", "unreadCount", "previousTotal", "currencyCode"]) expect(p, k).toHaveProperty(k);
    expect(S.CustomerQuoteSummary.required).toEqual(expect.arrayContaining(["unreadCount", "currencyCode"]));
    expect(p.previousTotal.nullable).toBe(true);
  });

  it("CustomerQuoteActions has canEditHeader (required)", () => {
    expect(S.CustomerQuoteActions.properties).toHaveProperty("canEditHeader");
    expect(S.CustomerQuoteActions.required).toContain("canEditHeader");
  });

  it("notification event key set is exactly the seven keys, all required", () => {
    expect(S.NotificationEvent.enum).toEqual(EVENTS);
    const ev = S.NotificationPrefs.properties.events;
    expect(Object.keys(ev.properties).sort()).toEqual([...EVENTS].sort());
    expect([...ev.required].sort()).toEqual([...EVENTS].sort());
    expect(ev.additionalProperties).toBe(false);
  });

  it("watchers have name, role, scope (all|jobId) and channels", () => {
    expect(Object.keys(S.Watcher.properties)).toEqual(expect.arrayContaining(["email", "name", "role", "scope", "channels"]));
    expect(S.NotificationPrefs.properties.watchers.items.$ref).toBe("#/components/schemas/Watcher");
    expect(S.WatcherScope.description).toMatch(/all/);
  });

  it("GET /c/quotes/{id}/pdf returns application/pdf", () => {
    const op = doc.paths["/c/quotes/{id}/pdf"].get;
    expect(op.operationId).toBe("getCustomerQuotePdf");
    expect(op.responses["200"].content["application/pdf"]).toBeTruthy();
  });

  it("currencyCode is an ISO 4217 code", () => {
    expect(S.CurrencyCode.pattern).toBe("^[A-Z]{3}$");
  });

  it("documents NOT_PURCHASABLE (ask for a new quote) and VERSION_MISMATCH (re-review)", () => {
    const checkout = doc.paths["/c/quotes/{id}/checkout"].post.description;
    expect(checkout).toMatch(/NOT_PURCHASABLE/);
    expect(checkout).toMatch(/Ask for a new quote/);
    expect(checkout).toMatch(/duplicate/);
    const accept = doc.paths["/c/quotes/{id}/accept"].post.description;
    expect(accept).toMatch(/VERSION_MISMATCH/);
    expect(accept).toMatch(/re-review/);
  });
});
