import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/** Contract revision 0.2.0: pins the requests recorded by each builder (see docs/CONTRACT-FOLLOWUPS.md). */
const doc = parse(readFileSync(resolve(__dirname, "../../../docs/openapi.yaml"), "utf8")) as any;
const S = doc.components.schemas;

describe("revision 0.2.0 / storefront", () => {
  it("FromCartRequest existing mode carries poNumber, neededBy, notesToSales", () => {
    const existing = S.FromCartRequest.properties.target.oneOf.find((o: any) => o.properties.mode.enum[0] === "existing");
    expect(Object.keys(existing.properties)).toEqual(expect.arrayContaining(["quoteId", "poNumber", "neededBy", "notesToSales"]));
    expect(existing.required).toEqual(["mode", "quoteId"]);
  });

  it("emptyCart is informational", () => {
    expect(S.FromCartRequest.properties.emptyCart.description).toMatch(/informational/i);
  });

  it("list limit allows up to 100", () => {
    expect(doc.components.parameters.Limit.schema.maximum).toBe(100);
    const params = doc.paths["/c/quotes"].get.parameters.map((p: any) => p.$ref);
    expect(params).toContain("#/components/parameters/Limit");
  });

  it("PUT /c/active-quote accepts a nullable quoteId", () => {
    const body = doc.paths["/c/active-quote"].put.requestBody.content["application/json"].schema;
    expect(body.properties.quoteId.nullable).toBe(true);
  });
});
