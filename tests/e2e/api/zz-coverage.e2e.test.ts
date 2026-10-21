/**
 * Runs last (alphabetical). Fails if any /c or /s operation in docs/openapi.yaml was never called with a success
 * status, or never with an error status, by the suite, so the contract cannot silently outgrow the tests.
 * /hooks/* (inbound email / Twilio) belong to apps/worker, which does not exist yet; they are listed, not tested.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { operations } from "./support/contract";
import { HITS_FILE } from "./support/env";

describe("contract coverage", () => {
  const hits: { method: string; path: string; status: number }[] = existsSync(HITS_FILE)
    ? readFileSync(HITS_FILE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const ops = operations().filter((o) => /^\/(c|s)\//.test(o.path));

  it("recorded a meaningful number of requests (run the whole suite, not a single file)", () => {
    expect(hits.length).toBeGreaterThan(300);
  });

  it("every customer and staff operation succeeded at least once", () => {
    const missing = ops.filter((o) => !hits.some((h) => h.method === o.method && h.path === o.path && h.status < 400)).map((o) => `${o.method} ${o.path}`);
    expect(missing).toEqual([]);
  });

  it("every customer and staff operation was also exercised on an error path", () => {
    const missing = ops.filter((o) => !hits.some((h) => h.method === o.method && h.path === o.path && h.status >= 400)).map((o) => `${o.method} ${o.path}`);
    expect(missing).toEqual([]);
  });

  it("no served route is missing from the contract (the harness throws on those; this lists what was seen)", () => {
    const known = new Set(operations().map((o) => `${o.method} ${o.path}`));
    expect(hits.filter((h) => !known.has(`${h.method} ${h.path}`))).toEqual([]);
  });

  it("webhook operations in the contract that this suite cannot reach yet", () => {
    const skipped = operations().filter((o) => o.path.startsWith("/hooks/")).map((o) => `${o.method} ${o.path}`);
    expect(skipped).toEqual(["POST /hooks/email-inbound", "POST /hooks/twilio-inbound"]); // fails when they are implemented: add tests then
  });
});
