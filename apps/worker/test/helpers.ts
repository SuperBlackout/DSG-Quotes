import type { Prisma, PrismaClient, Quote, Staff } from "@prisma/client";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { silentLogger, type NotifyConfig, type WorkerDeps } from "../src/config";
import { createPrisma } from "../src/db";
import { FakeEmailProvider, FakeSmsProvider } from "../src/providers/fakes";

export const SHOP = "dsg-test.myshopify.com";
export const CUSTOMER = "gid://shopify/Customer/1001";
export const PHONE = "+13125550123";
export const REP_PHONE = "+13125550199";
export const NOW = new Date("2026-03-02T15:00:00.000Z"); // 10:00 America/New_York

export const config: NotifyConfig = {
  shop: SHOP,
  appPublicUrl: "https://dsg.test/apps/quotes",
  adminQuoteUrl: "https://admin.test/quotes",
  emailFrom: "quotes@dsg.test",
  replyDomain: "reply.dsg.test",
  replySecret: "test-reply-secret",
  salesFallbackEmail: null,
  supportEmail: "help@dsg.test",
  supportPhone: null,
  bundleWindowMs: 5 * 60_000,
  maxAttempts: 3,
  retryBackoffMs: 60_000,
};

export interface Ctx {
  prisma: PrismaClient;
  deps: WorkerDeps;
  email: FakeEmailProvider;
  sms: FakeSmsProvider;
  clock: { now: Date };
}

const TABLES = ["Event", "Message", "QuoteLine", "QuoteVersion", "Quote", "Job", "NotificationPref", "CustomerProfile", "Counter", "WebhookReceipt", "Staff", "Team", "TeamMember", "NotificationLog", "SmsOptOut"];

export function useWorker(): Ctx {
  const ctx = {} as Ctx;
  beforeAll(() => {
    ctx.prisma = createPrisma(process.env.WORKER_TEST_DATABASE_URL!);
  });
  beforeEach(async () => {
    await ctx.prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
    ctx.clock = { now: new Date(NOW) };
    ctx.email = new FakeEmailProvider();
    ctx.sms = new FakeSmsProvider();
    ctx.deps = { prisma: ctx.prisma, email: ctx.email, sms: ctx.sms, config: { ...config }, now: () => new Date(ctx.clock.now), log: silentLogger };
  });
  afterAll(async () => {
    await ctx.prisma.$disconnect();
  });
  return ctx;
}

export async function mkStaff(p: PrismaClient, o: Partial<Staff> = {}): Promise<Staff> {
  return p.staff.create({ data: { shop: SHOP, name: "Rita Rep", email: "rita@dsg.test", ...o } });
}

let n = 100;
export async function mkQuote(p: PrismaClient, o: Partial<Quote> = {}): Promise<Quote> {
  const { assignedRepId, jobId, shipToAddress, ...rest } = o;
  void shipToAddress;
  return p.quote.create({
    data: ({
      shop: SHOP,
      number: ++n,
      title: "Lakeview Clinic",
      customerId: CUSTOMER,
      customerName: "Dana Dealer",
      customerEmail: "dana@acme.test",
      companyName: "Acme Dealers",
      status: "QUOTE_READY",
      currentVersion: 1,
      total: "1234.50",
      expiresAt: new Date("2026-03-16T00:00:00Z"),
      ...rest,
      ...(assignedRepId ? { assignedRepId } : {}),
      ...(jobId ? { jobId } : {}),
    } as Prisma.QuoteUncheckedCreateInput),
  });
}

/** Customer who opted in to SMS for the given events (default: email + SMS for everything). */
export async function mkCustomerPrefs(
  p: PrismaClient,
  o: { events?: string[]; sms?: boolean; email?: boolean; optedIn?: boolean; quietStart?: string | null; quietEnd?: string | null; phone?: string } = {},
) {
  const events = o.events ?? ["QUOTE_RECEIVED", "QUOTE_READY", "NEW_MESSAGE", "ACCEPTED", "ORDERED", "EXPIRING", "WEEKLY_SUMMARY"];
  await p.notificationPref.createMany({
    data: events.map((event) => ({
      shop: SHOP,
      customerId: CUSTOMER,
      event,
      email: o.email ?? true,
      sms: o.sms ?? true,
      phone: o.phone ?? PHONE,
      smsOptInAt: o.optedIn === false ? null : new Date("2026-01-01T00:00:00Z"),
      smsConsentText: "I agree",
      quietStart: o.quietStart ?? null,
      quietEnd: o.quietEnd ?? null,
      timezone: "America/New_York",
    })),
  });
}

export async function mkStaffPrefs(p: PrismaClient, staffId: string, events: string[], o: { phone?: string } = {}) {
  await p.notificationPref.createMany({
    data: events.map((event) => ({ shop: SHOP, staffId, event, email: true, sms: true, phone: o.phone ?? REP_PHONE, smsOptInAt: new Date("2026-01-01T00:00:00Z") })),
  });
}

export const mkEvent = (p: PrismaClient, quoteId: string, type: string, actorType: "CUSTOMER" | "STAFF" | "SYSTEM", payload: Record<string, unknown> = {}, createdAt = NOW) =>
  p.event.create({ data: { quoteId, type, actorType, payload: payload as object, createdAt } });

/** NotificationLog rows of a quote, oldest first. */
export const logs = (p: PrismaClient, quoteId: string) => p.notificationLog.findMany({ where: { quoteId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

/** A team with the given staff as members (Quote.teamId points at Team.id). */
export async function mkTeam(p: PrismaClient, name: string, staffIds: string[]) {
  const team = await p.team.create({ data: { shop: SHOP, name } });
  await p.teamMember.createMany({ data: staffIds.map((staffId) => ({ teamId: team.id, staffId })) });
  return team;
}
