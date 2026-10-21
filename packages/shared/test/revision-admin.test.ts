import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const doc = parse(readFileSync(resolve(__dirname, "../../../docs/openapi.yaml"), "utf8")) as any;
const S = doc.components.schemas;
const op = (path: string, method: string) => doc.paths[path]?.[method];

describe("revision 0.2.0 / admin", () => {
  it("adds the staff, team, settings, saved-reply and customer routes", () => {
    const expected: Array<[string, string, string]> = [
      ["/s/me", "get", "getStaffMe"],
      ["/s/staff", "get", "listStaff"],
      ["/s/staff/{id}", "put", "updateStaffMember"],
      ["/s/teams", "get", "listTeams"],
      ["/s/teams", "post", "createTeam"],
      ["/s/teams/{id}", "put", "updateTeam"],
      ["/s/teams/{id}", "delete", "deleteTeam"],
      ["/s/settings", "get", "getStaffSettings"],
      ["/s/settings", "put", "putStaffSettings"],
      ["/s/saved-replies", "get", "listSavedReplies"],
      ["/s/saved-replies", "put", "putSavedReplies"],
      ["/s/customers", "get", "searchStaffCustomers"],
      ["/s/quotes/{id}/request-floor-approval", "post", "requestFloorApproval"],
      ["/s/quotes/{id}/attachments/upload-url", "post", "createStaffAttachmentUpload"],
    ];
    for (const [p, m, id] of expected) {
      expect(op(p, m), `${m} ${p}`).toBeTruthy();
      expect(op(p, m).operationId).toBe(id);
      expect(op(p, m).tags).toEqual(["staff"]);
    }
  });

  it("every /s operation is secured by the staff session", () => {
    for (const [path, item] of Object.entries<any>(doc.paths)) {
      if (!path.startsWith("/s/")) continue;
      for (const [m, o] of Object.entries<any>(item)) {
        if (m === "parameters") continue;
        expect(o.security, `${m} ${path}`).toEqual([{ staffSession: [] }]);
      }
    }
  });

  it("settings carry defaultPriceFloorPct and routing rules", () => {
    expect(S.StaffSettings.required).toEqual(expect.arrayContaining(["defaultPriceFloorPct", "routing"]));
    const r = S.StaffSettings.properties.routing.properties;
    expect(Object.keys(r)).toEqual(expect.arrayContaining(["defaultTeamId", "autoAssignByCompany", "rules"]));
    expect(S.RoutingRule.properties).toHaveProperty("companyId");
  });

  it("staff roles are rep, manager, admin", () => {
    expect(S.StaffRole.enum).toEqual(["rep", "manager", "admin"]);
  });

  it("inbox documents rep=me|unassigned and Q-##### search", () => {
    const params = op("/s/quotes", "get").parameters;
    const rep = params.find((p: any) => p.name === "rep");
    expect(rep.description).toMatch(/me/);
    expect(rep.description).toMatch(/unassigned/);
    const q = params.find((p: any) => p.name === "q");
    expect(q.description).toMatch(/Q-10482/);
  });

  it("StaffSummary has tabCounts for exactly the inbox tabs", () => {
    const tabs = op("/s/quotes", "get").parameters.find((p: any) => p.name === "tab").schema.enum;
    const tc = S.StaffSummary.properties.tabCounts;
    expect(Object.keys(tc.properties).sort()).toEqual([...tabs].sort());
    expect(S.StaffSummary.required).toContain("tabCounts");
  });

  it("StaffQuote has payment terms, contact name/phone, workingExpiresAt, nextVersionNo", () => {
    const p = S.StaffQuote.allOf[1].properties;
    for (const k of ["paymentTerms", "customerContactName", "customerContactPhone", "workingExpiresAt", "nextVersionNo"])
      expect(p, k).toHaveProperty(k);
  });

  it("inbox rows have itemCount and currencyCode", () => {
    expect(S.StaffQuoteSummary.properties).toHaveProperty("itemCount");
    expect(S.StaffQuoteSummary.required).toEqual(expect.arrayContaining(["itemCount", "currencyCode"]));
  });

  it("variant cost is snapshotted by draft-revision; no variant lookup route exists", () => {
    expect(Object.keys(doc.paths).some((p) => p.startsWith("/s/variants"))).toBe(false);
    expect(S.StaffLineInput.description).toMatch(/snapshots/);
    expect(S.StaffLineInput.description).toMatch(/cost/);
  });

  it("Send vN is max(currentVersion, highest versions[].versionNo)+1", () => {
    expect(op("/s/quotes/{id}/send", "post").description).toMatch(/max\(currentVersion, highest versions\[\]\.versionNo\) \+ 1/);
    expect(S.StaffQuote.allOf[1].properties.nextVersionNo.description).toMatch(/\+ 1/);
  });

  it("unknown cost requires manager floor approval before send", () => {
    expect(S.StaffQuoteLine.properties).toHaveProperty("costUnknown");
    expect(op("/s/quotes/{id}/send", "post").description).toMatch(/unknown\s+cost/);
    expect(op("/s/quotes/{id}/approve-floor", "post").description).toMatch(/manager or admin/);
  });

  it("request-floor-approval notifies managers without a status change", () => {
    const o = op("/s/quotes/{id}/request-floor-approval", "post");
    expect(o.description).toMatch(/notifies every manager/);
    expect(o.description).toMatch(/No status change/);
  });

  it("staff attachment upload reuses the customer upload shapes", () => {
    const o = op("/s/quotes/{id}/attachments/upload-url", "post");
    expect(o.requestBody.content["application/json"].schema.$ref).toBe("#/components/schemas/UploadUrlRequest");
    expect(o.responses["200"].content["application/json"].schema.$ref).toBe("#/components/schemas/UploadUrl");
  });

  it("no schema property carries stray keys (guards unquoted flow-mapping descriptions)", () => {
    const allowed = new Set([
      "type", "format", "description", "example", "enum", "nullable", "readOnly", "pattern", "minimum", "maximum",
      "minLength", "maxLength", "minItems", "maxItems", "minProperties", "default", "items", "properties", "required",
      "additionalProperties", "allOf", "oneOf", "anyOf", "$ref",
    ]);
    const walk = (s: any, where: string) => {
      if (!s || typeof s !== "object") return;
      for (const k of Object.keys(s)) {
        if (["properties"].includes(k)) for (const [n, v] of Object.entries<any>(s[k])) walk(v, `${where}.${n}`);
        else if (k === "items" || k === "additionalProperties") walk(s[k], `${where}.${k}`);
        else if (["allOf", "oneOf", "anyOf"].includes(k)) s[k].forEach((x: any, i: number) => walk(x, `${where}.${k}[${i}]`));
        else expect(allowed.has(k), `${where} has unexpected key "${k}"`).toBe(true);
      }
    };
    for (const [n, s] of Object.entries<any>(S)) walk(s, n);
  });

  it("staff-only data stays out of Customer* schemas", () => {
    const staffOnly = ["costUnknown", "paymentTerms", "customerContactName", "customerContactPhone", "workingExpiresAt", "nextVersionNo", "itemCount", "tabCounts"];
    for (const name of Object.keys(S).filter((n) => /^Customer/.test(n)))
      for (const k of staffOnly) expect(JSON.stringify(S[name]), `${name} leaks ${k}`).not.toContain(`"${k}"`);
  });
});
