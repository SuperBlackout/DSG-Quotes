import { describe, expect, it } from "vitest";
import { runCron } from "../src/cron/run";
import { expireDueQuotes } from "../src/cron/expire";
import { processBatch } from "../src/processor";
import { mkCustomerPrefs, mkEvent, mkQuote, mkStaff, useWorker } from "./helpers";

const ctx = useWorker();

describe("hourly EXPIRE", () => {
  it("expires QUOTE_READY and ACCEPTED quotes past expiry through transition(), one events row each, and notifies the customer", async () => {
    await mkCustomerPrefs(ctx.prisma);
    const a = await mkQuote(ctx.prisma, { expiresAt: new Date("2026-03-01T00:00:00Z") });
    const b = await mkQuote(ctx.prisma, { status: "ACCEPTED", expiresAt: new Date("2026-03-02T14:00:00Z") });
    const fresh = await mkQuote(ctx.prisma, { expiresAt: new Date("2026-03-10T00:00:00Z") });
    const ordered = await mkQuote(ctx.prisma, { status: "ORDERED", expiresAt: new Date("2026-03-01T00:00:00Z") });
    const draft = await mkQuote(ctx.prisma, { status: "DRAFT", expiresAt: new Date("2026-03-01T00:00:00Z") });

    const { expired } = await expireDueQuotes(ctx.deps);
    expect(expired.sort()).toEqual([a.id, b.id].sort());
    const status = async (id: string) => (await ctx.prisma.quote.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(a.id)).toBe("EXPIRED");
    expect(await status(b.id)).toBe("EXPIRED");
    expect(await status(fresh.id)).toBe("QUOTE_READY");
    expect(await status(ordered.id)).toBe("ORDERED");
    expect(await status(draft.id)).toBe("DRAFT");

    const ev = await ctx.prisma.event.findMany({ where: { type: "EXPIRE" } });
    expect(ev).toHaveLength(2);
    expect(ev.every((e) => e.actorType === "SYSTEM" && e.notifiedAt === null)).toBe(true);
    expect((ev.find((e) => e.quoteId === a.id)!.payload as any).from).toBe("QUOTE_READY");

    expect((await expireDueQuotes(ctx.deps)).expired).toEqual([]); // idempotent
    await processBatch(ctx.deps);
    expect(ctx.email.sent.filter((m) => m.subject.includes("expired"))).toHaveLength(2);
  });
});

describe("daily 8:00 ET reminders and rep digest", () => {
  it("does not run the daily jobs before 8:00 ET (13:00 UTC in March)", async () => {
    ctx.clock.now = new Date("2026-03-02T12:00:00Z"); // 07:00 ET
    const q = await mkQuote(ctx.prisma, { expiresAt: new Date("2026-03-04T12:00:00Z") });
    const r = await runCron(ctx.deps);
    expect(r.ranDaily).toBe(false);
    expect(await ctx.prisma.event.count({ where: { quoteId: q.id, type: "EXPIRING" } })).toBe(0);
  });

  it("queues one EXPIRING event per quote expiring within 3 days, once per expiry date, and the worker notifies on both channels", async () => {
    await mkCustomerPrefs(ctx.prisma);
    ctx.clock.now = new Date("2026-03-02T13:05:00Z"); // 08:05 ET
    const soon = await mkQuote(ctx.prisma, { expiresAt: new Date("2026-03-05T00:00:00Z") });
    await mkQuote(ctx.prisma, { expiresAt: new Date("2026-03-20T00:00:00Z") });
    const r = await runCron(ctx.deps);
    expect(r.remindersQueued).toBe(1);
    await runCron(ctx.deps); // same day, again: marker blocks it
    ctx.clock.now = new Date("2026-03-03T13:05:00Z");
    expect((await runCron(ctx.deps)).remindersQueued).toBe(0); // next day, already reminded for this expiry

    expect(await ctx.prisma.event.count({ where: { quoteId: soon.id, type: "EXPIRING" } })).toBe(1);
    await processBatch(ctx.deps);
    expect(ctx.email.sent.filter((m) => m.subject.includes("expires"))).toHaveLength(1);
    expect(ctx.sms.sent.filter((m) => m.body.includes("expires"))).toHaveLength(1);

    // a rep extends the expiry: new date, new reminder
    await ctx.prisma.quote.update({ where: { id: soon.id }, data: { expiresAt: new Date("2026-03-06T00:00:00Z") } });
    ctx.clock.now = new Date("2026-03-04T13:05:00Z");
    expect((await runCron(ctx.deps)).remindersQueued).toBe(1);
  });

  it("sends each rep one digest per day, only when there is something to act on, and managers also get the unassigned queue", async () => {
    ctx.clock.now = new Date("2026-03-02T13:05:00Z");
    const rep = await mkStaff(ctx.prisma, { email: "rita@dsg.test", name: "Rita" });
    await mkStaff(ctx.prisma, { email: "idle@dsg.test", name: "Idle" });
    const mgr = await mkStaff(ctx.prisma, { email: "boss@dsg.test", name: "Boss", isManager: true });
    await mkQuote(ctx.prisma, { status: "SUBMITTED", assignedRepId: rep.id, title: "Needs reply" });
    await mkQuote(ctx.prisma, { status: "SUBMITTED", title: "Nobody has it" });
    await mkQuote(ctx.prisma, { status: "QUOTE_READY", assignedRepId: mgr.id, expiresAt: new Date("2026-03-04T00:00:00Z"), title: "Lapsing" });

    const r = await runCron(ctx.deps);
    expect(r.digestsSent).toBe(2);
    const to = ctx.email.sent.map((m) => m.to).sort();
    expect(to).toEqual(["boss@dsg.test", "rita@dsg.test"]);
    const boss = ctx.email.sent.find((m) => m.to === "boss@dsg.test")!;
    expect(boss.text).toContain("Nobody has it");
    expect(boss.text).toContain("Lapsing");
    expect(ctx.email.sent.find((m) => m.to === "rita@dsg.test")!.text).toContain("Needs reply");

    await runCron(ctx.deps);
    expect(ctx.email.sent).toHaveLength(2); // once a day
    ctx.clock.now = new Date("2026-03-03T13:05:00Z");
    await runCron(ctx.deps);
    expect(ctx.email.sent).toHaveLength(4);
  });

  it("a rep can opt out of the digest", async () => {
    ctx.clock.now = new Date("2026-03-02T13:05:00Z");
    const rep = await mkStaff(ctx.prisma);
    await mkQuote(ctx.prisma, { status: "SUBMITTED", assignedRepId: rep.id });
    await ctx.prisma.notificationPref.create({ data: { shop: "dsg-test.myshopify.com", staffId: rep.id, event: "DIGEST", email: false } });
    await runCron(ctx.deps);
    expect(ctx.email.sent).toHaveLength(0);
  });

  it("runs the daily jobs at 8:00 ET across the DST change (12:30 UTC after 8 March)", async () => {
    ctx.clock.now = new Date("2026-03-09T12:30:00Z"); // 08:30 EDT
    const q = await mkQuote(ctx.prisma, { expiresAt: new Date("2026-03-11T12:00:00Z") });
    await runCron(ctx.deps);
    expect(await ctx.prisma.event.count({ where: { quoteId: q.id, type: "EXPIRING" } })).toBe(1);
    void mkEvent;
  });
});
