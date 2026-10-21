// Smoke test against the Prism mock (or any live API). Skipped unless MOCK_API_URL is set:
//
//   pnpm -F shared mock                                   # terminal 1 (serves :4010)
//   MOCK_API_URL=http://localhost:4010 pnpm -F my-quotes test
//
// Prism returns random-but-schema-valid data, so this proves the typed client talks to the contract
// and that the view logic survives arbitrary payloads, not that the data is realistic.
import { describe, expect, it } from "vitest";
import { createApiClient } from "../src/api/client";
import { buildDetailView, versionTabs } from "../src/lib/detail";
import { chipCounts, groupQuotes } from "../src/lib/filters";
import { formFromPrefs, validatePrefs } from "../src/lib/notifications";
import { rowActions, statusBanner } from "../src/lib/status";

const url = process.env.MOCK_API_URL;

describe.skipIf(!url)("against the API mock", () => {
  const api = createApiClient({ baseUrl: url ?? "", getToken: async () => "mock" });

  it("lists quotes and derives chips, groups and row actions", async () => {
    const page = await api.listQuotes();
    expect(Array.isArray(page.items)).toBe(true);
    for (const q of page.items) expect(rowActions(q).length).toBeGreaterThan(0);
    expect(() => chipCounts(page.items)).not.toThrow();
    expect(() => groupQuotes(page.items, "job")).not.toThrow();
  });

  it("loads a quote and builds the detail view", async () => {
    const q = await api.getQuote("any-id");
    expect(q.id).toBeTruthy();
    expect(() => statusBanner(q)).not.toThrow();
    expect(() => buildDetailView(q)).not.toThrow();
    expect(() => versionTabs(q)).not.toThrow();
  });

  it("loads and re-saves notification prefs", async () => {
    const p = await api.getNotificationPrefs();
    const form = formFromPrefs(p);
    expect(typeof validatePrefs(form)).toBe("object");
    const saved = await api.putNotificationPrefs(p);
    expect(saved.events).toBeDefined();
  });

  it("posts a message and requests an upload URL", async () => {
    const m = await api.postMessage("any-id", { body: "hello" });
    expect(m.body).toBeDefined();
    const up = await api.createUpload("any-id", { name: "a.pdf", size: 10, mime: "application/pdf" });
    expect(up.uploadUrl).toBeTruthy();
  });

  it("checkout returns a redirect target", async () => {
    const res = await api.checkout("any-id");
    expect(res.invoiceUrl).toBeTruthy();
  });
});
