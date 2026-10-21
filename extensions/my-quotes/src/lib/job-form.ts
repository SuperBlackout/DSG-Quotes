// Job-details edit form (screen 4): form state <-> PATCH /c/quotes/{id} body.
import type { Address, CustomerQuote, UpdateQuoteRequest } from "../api/types";

export interface JobForm {
  title: string;
  poNumber: string;
  neededBy: string; // YYYY-MM-DD or ""
  address1: string;
  address2: string;
  city: string;
  province: string;
  zip: string;
  notesToSales: string;
}

export function jobFormFrom(q: CustomerQuote): JobForm {
  return {
    title: q.title,
    poNumber: q.poNumber ?? q.job?.poNumber ?? "",
    neededBy: q.neededBy ?? "",
    address1: q.shipTo?.address1 ?? "",
    address2: q.shipTo?.address2 ?? "",
    city: q.shipTo?.city ?? "",
    province: q.shipTo?.province ?? "",
    zip: q.shipTo?.zip ?? "",
    notesToSales: q.notesToSales ?? "",
  };
}

const ADDRESS_KEYS = ["address1", "address2", "city", "province", "zip"] as const;

/** One-line ship-to for display: "22 Lake Rd, Ronkonkoma NY 11779". Falls back to the job's site. */
export function formatShipTo(q: Pick<CustomerQuote, "shipTo" | "job">): string {
  const a = q.shipTo;
  if (a) {
    const street = [a.address1, a.address2].filter(Boolean).join(" ");
    const region = [a.province, a.zip].filter(Boolean).join(" ");
    const line = [street, a.city, region].filter(Boolean).join(", ");
    if (line) return line;
  }
  return q.job?.siteAddress ?? "";
}

/**
 * Only the fields the customer actually changed, so an edit never overwrites something the rep
 * updated in the meantime. Returns undefined when nothing changed. Clearing a field sends null.
 */
export function buildJobUpdate(original: CustomerQuote, form: JobForm): UpdateQuoteRequest | undefined {
  const before = jobFormFrom(original);
  const patch: UpdateQuoteRequest = {};

  const title = form.title.trim();
  if (title !== before.title) patch.title = title;

  const po = form.poNumber.trim();
  if (po !== before.poNumber.trim()) patch.poNumber = po === "" ? null : po;

  if (form.neededBy !== before.neededBy) patch.neededBy = form.neededBy === "" ? null : form.neededBy;

  if (ADDRESS_KEYS.some((k) => form[k].trim() !== before[k].trim())) {
    const next: Address = { ...(original.shipTo ?? {}) };
    for (const k of ADDRESS_KEYS) {
      const v = form[k].trim();
      if (v) next[k] = v;
      else delete next[k];
    }
    patch.shipTo = ADDRESS_KEYS.every((k) => !form[k].trim()) ? null : next;
  }

  const note = form.notesToSales.trim();
  if (note !== (original.notesToSales ?? "").trim()) patch.notesToSales = note === "" ? null : note;

  return Object.keys(patch).length > 0 ? patch : undefined;
}

export function validateJobForm(form: JobForm): { title?: string; neededBy?: string } {
  const errors: { title?: string; neededBy?: string } = {};
  if (!form.title.trim()) errors.title = "Give the quote a name.";
  if (form.neededBy && !/^\d{4}-\d{2}-\d{2}$/.test(form.neededBy)) errors.neededBy = "Use the date picker.";
  return errors;
}
