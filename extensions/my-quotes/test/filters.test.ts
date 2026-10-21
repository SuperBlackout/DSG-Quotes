import { describe, expect, it } from "vitest";
import type { CustomerQuoteSummary } from "../src/api/types";
import { chipCounts, filterQuotes, groupQuotes, listSubtitle, matchesChip, matchesSearch } from "../src/lib/filters";
import { summary } from "./fixtures";

const lake = { id: "j-lake", name: "Lakeview Clinic", poNumber: "4471", siteAddress: "22 Lake Rd" };
const harbor = { id: "j-harbor", name: "Harbor Middle School — Auditorium", poNumber: null };
const church = { id: "j-church", name: "Ridgeway Church — PA upgrade", poNumber: "RC-2026-09" };
const dental = { id: "j-dental", name: "Northfield Dental — cameras", poNumber: "88120" };

// The seven quotes of mockup screen 3.
const quotes: CustomerQuoteSummary[] = [
  summary({ id: "a", number: 10482, displayNumber: "Q-10482", title: "Exam rooms AV", status: "QUOTE_READY", job: lake, total: "3640.00", updatedAt: "2026-10-21T10:00:00Z" }),
  summary({ id: "b", number: 10455, displayNumber: "Q-10455", title: "Lobby digital signage", status: "ACCEPTED", job: lake, total: "2118.00", updatedAt: "2026-10-19T10:00:00Z" }),
  summary({ id: "c", number: 10477, displayNumber: "Q-10477", title: "Main system — option A", status: "DRAFT", job: harbor, total: "18240.50", updatedAt: "2026-10-20T10:00:00Z" }),
  summary({ id: "d", number: 10479, displayNumber: "Q-10479", title: "Option B — wireless mics", status: "SUBMITTED", job: harbor, total: "6740.00", updatedAt: "2026-10-21T08:14:00Z" }),
  summary({ id: "e", number: 10461, displayNumber: "Q-10461", title: "Sanctuary speakers + amp", status: "CHANGES_REQUESTED", job: church, total: "3911.00", updatedAt: "2026-10-20T09:00:00Z" }),
  summary({ id: "f", number: 10398, displayNumber: "Q-10398", title: "First pass — budget", status: "EXPIRED", job: church, total: "709.00", updatedAt: "2026-09-22T09:00:00Z" }),
  summary({ id: "g", number: 10431, displayNumber: "Q-10431", title: "12 dome cameras + NVR", status: "ORDERED", job: dental, total: "5302.00", updatedAt: "2026-10-12T09:00:00Z", orderId: "o1" }),
];

describe("filter chips", () => {
  it("reproduce the mockup counts: All 7, Waiting on you 2, With sales 2, Drafts 1, Closed 2", () => {
    expect(chipCounts(quotes)).toEqual({ all: 7, waiting: 2, sales: 2, drafts: 1, closed: 2 });
  });

  it("Waiting on you excludes drafts even though the draft is waiting on the customer", () => {
    const draft = quotes.find((q) => q.status === "DRAFT")!;
    expect(draft.waitingOn).toBe("customer");
    expect(matchesChip(draft, "waiting")).toBe(false);
    expect(matchesChip(draft, "drafts")).toBe(true);
  });

  it("IN_REVIEW counts as With sales; DECLINED as Closed", () => {
    expect(matchesChip(summary({ status: "IN_REVIEW" }), "sales")).toBe(true);
    expect(matchesChip(summary({ status: "DECLINED" }), "closed")).toBe(true);
  });

  it("filterQuotes combines chip and search", () => {
    expect(filterQuotes(quotes, "waiting", "").map((q) => q.id).sort()).toEqual(["a", "b"]);
    expect(filterQuotes(quotes, "waiting", "signage").map((q) => q.id)).toEqual(["b"]);
  });
});

describe("search", () => {
  it("matches quote number with or without the prefix", () => {
    expect(matchesSearch(quotes[0]!, "Q-10482")).toBe(true);
    expect(matchesSearch(quotes[0]!, "10482")).toBe(true);
    expect(matchesSearch(quotes[0]!, "10455")).toBe(false);
  });

  it("matches job name, PO and title case-insensitively, all words required", () => {
    expect(matchesSearch(quotes[0]!, "lakeview")).toBe(true);
    expect(matchesSearch(quotes[0]!, "4471")).toBe(true);
    expect(matchesSearch(quotes[0]!, "EXAM av")).toBe(true);
    expect(matchesSearch(quotes[0]!, "exam church")).toBe(false);
  });

  it("matches the visible status wording", () => {
    expect(matchesSearch(quotes[4]!, "changes requested")).toBe(true);
  });

  it("empty search matches everything", () => {
    expect(quotes.every((q) => matchesSearch(q, "   "))).toBe(true);
  });
});

describe("groupQuotes", () => {
  it("groups by job, newest group first, with count and total", () => {
    const groups = groupQuotes(quotes, "job");
    expect(groups.map((g) => g.title)).toEqual([
      "Lakeview Clinic",
      "Harbor Middle School — Auditorium",
      "Ridgeway Church — PA upgrade",
      "Northfield Dental — cameras",
    ]);
    expect(groups[0]!.summary).toBe("2 quotes · $5,758.00");
    expect(groups[1]!.summary).toBe("2 quotes · $24,980.50");
    expect(groups[2]!.summary).toBe("2 quotes · $4,620.00");
    expect(groups[3]!.summary).toBe("1 quote · $5,302.00");
    expect(groups[0]!.job?.poNumber).toBe("4471");
  });

  it("orders quotes inside a job newest first", () => {
    expect(groupQuotes(quotes, "job")[0]!.quotes.map((q) => q.id)).toEqual(["a", "b"]);
  });

  it("puts job-less quotes in a 'No job' group", () => {
    const groups = groupQuotes([summary({ status: "DRAFT", job: null })], "job");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.title).toBe("No job");
  });

  it("groups by status using plain status names", () => {
    const titles = groupQuotes(quotes, "status").map((g) => g.title);
    expect(titles).toContain("Quote ready");
    expect(titles).toContain("Expired");
  });

  it("'none' returns a single untitled group, and nothing for an empty list", () => {
    expect(groupQuotes(quotes, "none")).toHaveLength(1);
    expect(groupQuotes([], "none")).toEqual([]);
    expect(groupQuotes([], "job")).toEqual([]);
  });

  it("builds the subtitle", () => {
    expect(listSubtitle(quotes)).toBe("7 quotes across 4 jobs");
    expect(listSubtitle([quotes[0]!])).toBe("1 quote across 1 job");
  });
});
