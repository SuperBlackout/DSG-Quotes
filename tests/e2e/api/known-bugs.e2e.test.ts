/**
 * KNOWN BUGS in apps/api found by QA. Each test states the EXPECTED behaviour and is wrapped in `it.fails`, so the suite
 * is green today and turns red ("expected to fail but passed") the moment the backend fixes the bug; then delete the
 * `.fails`. Reproductions are also listed in the QA report.
 */
import { describe, expect, it } from "vitest";
import { claimAndPrice, draftWith, submitted } from "./support/flows";
import * as F from "./support/fixtures";
import { useWorld } from "./support/world";

const clientError = (status: number) => status >= 400 && status < 500;

describe("known bugs (apps/api)", () => {
  const w = useWorld();

  it.fails("BUG-1 POST /c/quotes with a calendar-invalid neededBy (2026-13-45) must be a 4xx, not a 500", async () => {
    const r = await w.dana.post("/c/quotes", { title: "x", neededBy: "2026-13-45" }, { loose: true });
    expect(clientError(r.status), `got ${r.status} ${r.text}`).toBe(true);
  });

  it.fails("BUG-1b PATCH /c/quotes/:id with neededBy 2026-02-31 must be rejected, not stored", async () => {
    const q = await draftWith(w.dana);
    const r = await w.dana.patch(`/c/quotes/${q.id}`, { neededBy: "2026-02-31" }, { loose: true });
    expect(clientError(r.status), `got ${r.status} neededBy=${r.body?.neededBy}`).toBe(true);
  });

  it.fails("BUG-2 PUT /s/quotes/:id/draft-revision with expiresAt '2026-03-05T00:00:00+99:00' must be a 4xx, not a 500", async () => {
    const q = await submitted(w.dana);
    await claimAndPrice(w.rep1, q.id);
    const r = await w.rep1.put(`/s/quotes/${q.id}/draft-revision`, { lines: [{ variantId: F.V_PIPE, qty: 1, quotedPrice: "1.00" }], expiresAt: "2026-03-05T00:00:00+99:00" }, { loose: true });
    expect(clientError(r.status), `got ${r.status}`).toBe(true);
  });

  it.fails("BUG-3 PUT /s/quotes/:id/draft-revision with quotedPrice 99999999999999.99 must be a 4xx, not a 500 (numeric overflow)", async () => {
    const q = await submitted(w.dana);
    await claimAndPrice(w.rep1, q.id);
    const r = await w.rep1.put(`/s/quotes/${q.id}/draft-revision`, { lines: [{ variantId: F.V_PIPE, qty: 1, quotedPrice: "99999999999999.99" }] }, { loose: true });
    expect(clientError(r.status), `got ${r.status}`).toBe(true);
  });

  it.fails("BUG-4 staff cannot post a customer-visible message on a customer's private DRAFT (the dealer gets 409 NOT_EDITABLE for the same action)", async () => {
    const d = await draftWith(w.dana);
    const r = await w.rep1.post(`/s/quotes/${d.id}/messages`, { body: "hi" });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});
