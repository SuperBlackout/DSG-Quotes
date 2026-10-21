import { describe, expect, it } from "vitest";
import { buildJobUpdate, formatShipTo, jobFormFrom, validateJobForm } from "../src/lib/job-form";
import { orderHref } from "../src/router";
import { quoteSubline } from "../src/lib/status";
import { quote, summary } from "./fixtures";

const base = () =>
  quote({
    status: "QUOTE_READY",
    title: "Exam rooms AV",
    poNumber: "4471",
    neededBy: "2026-11-10",
    notesToSales: "Bid due Friday.",
    shipTo: { name: "Job site", address1: "22 Lake Rd", city: "Ronkonkoma", province: "NY", zip: "11779", country: "US" },
  });

describe("buildJobUpdate", () => {
  it("returns undefined when nothing changed", () => {
    const q = base();
    expect(buildJobUpdate(q, jobFormFrom(q))).toBeUndefined();
  });

  it("sends only the changed fields", () => {
    const q = base();
    expect(buildJobUpdate(q, { ...jobFormFrom(q), poNumber: "4472", neededBy: "2026-11-12" })).toEqual({
      poNumber: "4472",
      neededBy: "2026-11-12",
    });
  });

  it("sends null when a field is cleared", () => {
    const q = base();
    expect(buildJobUpdate(q, { ...jobFormFrom(q), poNumber: "", neededBy: "", notesToSales: " " })).toEqual({
      poNumber: null,
      neededBy: null,
      notesToSales: null,
    });
  });

  it("merges address edits into the existing shipTo so name/country survive", () => {
    const q = base();
    const patch = buildJobUpdate(q, { ...jobFormFrom(q), city: "Hauppauge" });
    expect(patch?.shipTo).toEqual({
      name: "Job site",
      address1: "22 Lake Rd",
      city: "Hauppauge",
      province: "NY",
      zip: "11779",
      country: "US",
    });
  });

  it("clears shipTo entirely when every address field is blank", () => {
    const q = base();
    const f = { ...jobFormFrom(q), address1: "", address2: "", city: "", province: "", zip: "" };
    expect(buildJobUpdate(q, f)?.shipTo).toBeNull();
  });

  it("never includes fields outside the PATCH contract", () => {
    const q = base();
    const patch = buildJobUpdate(q, { ...jobFormFrom(q), title: "New", poNumber: "x", notesToSales: "y" })!;
    const allowed = ["title", "jobId", "newJob", "poNumber", "neededBy", "shipTo", "notesToSales", "watchers"];
    for (const k of Object.keys(patch)) expect(allowed).toContain(k);
  });
});

describe("job form helpers", () => {
  it("falls back to the job's PO when the quote has none", () => {
    const q = quote({ status: "DRAFT", poNumber: null, job: { id: "j", name: "J", poNumber: "9" } });
    expect(jobFormFrom(q).poNumber).toBe("9");
  });

  it("formats the ship-to line, falling back to the job site", () => {
    expect(formatShipTo(base())).toBe("22 Lake Rd, Ronkonkoma, NY 11779");
    expect(formatShipTo(quote({ status: "DRAFT", shipTo: null, job: { id: "j", name: "J", siteAddress: "22 Lake Rd" } }))).toBe(
      "22 Lake Rd",
    );
    expect(formatShipTo(quote({ status: "DRAFT", shipTo: null, job: null }))).toBe("");
  });

  it("requires a quote name", () => {
    expect(validateJobForm({ ...jobFormFrom(base()), title: "  " }).title).toBeDefined();
    expect(validateJobForm(jobFormFrom(base()))).toEqual({});
  });
});

describe("orderHref", () => {
  it("builds the customer-account order route from a GID or numeric id", () => {
    expect(orderHref("gid://shopify/Order/5821400")).toBe("shopify:customer-account/orders/5821400");
    expect(orderHref("5821400")).toBe("shopify:customer-account/orders/5821400");
  });
  it("falls back to the orders list", () => {
    expect(orderHref(null)).toBe("shopify:customer-account/orders");
    expect(orderHref("DSG-ABC")).toBe("shopify:customer-account/orders");
  });
});

describe("quoteSubline", () => {
  it("mirrors the mockup wording per status", () => {
    expect(quoteSubline(summary({ status: "QUOTE_READY", lineCount: 6, ownerName: "Dana K.", expiresAt: "2026-11-04T12:00:00.000Z" }))).toMatch(
      /^6 items · Owner: Dana K\. · expires Nov 4$/,
    );
    expect(quoteSubline(summary({ status: "DRAFT", lineCount: 14, ownerName: undefined }))).toBe("14 items · not submitted");
    expect(quoteSubline(summary({ status: "SUBMITTED", lineCount: 9, ownerName: undefined }))).toBe("9 items · sent to sales team");
    expect(quoteSubline(summary({ status: "EXPIRED", lineCount: 5, ownerName: undefined, expiresAt: "2026-10-06T12:00:00.000Z" }))).toBe(
      "5 items · expired Oct 6",
    );
  });
});
