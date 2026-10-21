import { describe, expect, it } from "vitest";
import { seed } from "../prisma/seed";
import { testConfig, useHarness } from "./helpers";

describe("prisma seed", () => {
  const h = useHarness();

  it("creates 3 companies and quotes in every one of the 10 statuses, all reached through transition() events", async () => {
    const config = { ...testConfig(), shopDomain: testConfig().shopDomain };
    const res = await seed(h.prisma, config, { reset: true });
    expect(res.quotes.length).toBeGreaterThanOrEqual(12);

    const rows = await h.prisma.quote.findMany();
    const statuses = new Set(rows.map((q) => q.status));
    for (const s of ["DRAFT", "SUBMITTED", "IN_REVIEW", "QUOTE_READY", "CHANGES_REQUESTED", "ACCEPTED", "ORDERED", "EXPIRED", "DECLINED", "ARCHIVED"]) {
      expect(statuses, `missing ${s}`).toContain(s);
    }
    expect(new Set(rows.map((q) => q.companyId)).size).toBe(3);
    expect(rows.some((q) => q.currentVersion >= 2)).toBe(true);
    expect(rows.some((q) => q.belowFloor)).toBe(true);

    // Every non-draft quote got there via events whose from/to chain ends at its stored status.
    for (const q of rows) {
      const ev = (await h.prisma.event.findMany({ where: { quoteId: q.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).filter((e) => (e.payload as any)?.to);
      const last = ev[ev.length - 1];
      if (q.status === "DRAFT") expect(ev.every((e) => (e.payload as any).to === "DRAFT" || (e.payload as any).from === "SUBMITTED")).toBe(true);
      else expect((last!.payload as any).to, `quote ${q.number}`).toBe(q.status);
    }
    // Internal note exists but is staff only.
    expect(await h.prisma.message.count({ where: { internal: true } })).toBeGreaterThan(0);
  });

  it("refuses to run over existing data without --reset, and refuses production", async () => {
    await seed(h.prisma, testConfig(), { reset: true });
    await expect(seed(h.prisma, testConfig())).rejects.toThrow(/--reset/);
    await expect(seed(h.prisma, { ...testConfig(), nodeEnv: "production" }, { reset: true })).rejects.toThrow(/production/);
  });
});
