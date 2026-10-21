import { NOTIFY } from "shared";

/** Notification templates = the rows of the plan's Notifications table. */
export type Template = "submitted" | "quote_ready" | "new_message" | "changes_requested" | "accepted" | "ordered" | "expiring" | "floor_approval";
/** `managers` = active staff with role manager or admin (never customers). */
export type Side = "customer" | "sales" | "managers";

/** The seven customer-facing preference keys (`NotificationPrefs.events`, apps/api routes/customerPrefs.ts PREF_EVENTS). */
export const CUSTOMER_PREF_EVENTS = ["QUOTE_RECEIVED", "QUOTE_READY", "NEW_MESSAGE", "EXPIRING", "ORDERED", "ACCEPTED", "WEEKLY_SUMMARY"] as const;
export type CustomerPrefKey = (typeof CUSTOMER_PREF_EVENTS)[number];
/** Staff-only keys (no settings screen yet: a staff NotificationPref row with that `event` overrides the email-on default). */
export type StaffPrefKey = CustomerPrefKey | "CHANGES_REQUESTED" | "FLOOR_APPROVAL_REQUESTED";

export interface NotifyPlan {
  template: Template;
  /** `NotificationPref.event` for the customer side. null = no customer preference (staff-bound event). */
  customerPrefKey: CustomerPrefKey | null;
  /** `NotificationPref.event` for staff recipients. */
  salesPrefKey: StaffPrefKey;
  sides: Side[];
  /** EXPIRE (already lapsed) rather than EXPIRING (3 days left): same template, different wording. */
  expired?: boolean;
}

const SIDES = { sales: ["sales"], customer: ["customer"], both: ["customer", "sales"] } as const;

/** Event type -> template and preference keys. The audience comes from the shared NOTIFY map. */
const TEMPLATES: Record<string, { template: Template; customerPrefKey: CustomerPrefKey | null; salesPrefKey: StaffPrefKey; expired?: boolean }> = {
  SUBMIT: { template: "submitted", customerPrefKey: "QUOTE_RECEIVED", salesPrefKey: "QUOTE_RECEIVED" },
  SEND_REVISION: { template: "quote_ready", customerPrefKey: "QUOTE_READY", salesPrefKey: "QUOTE_READY" },
  // Goes to sales only: the customer has no preference key for their own change request.
  REQUEST_CHANGES: { template: "changes_requested", customerPrefKey: null, salesPrefKey: "CHANGES_REQUESTED" },
  ACCEPT: { template: "accepted", customerPrefKey: "ACCEPTED", salesPrefKey: "ACCEPTED" },
  ORDER_PLACED: { template: "ordered", customerPrefKey: "ORDERED", salesPrefKey: "ORDERED" },
  EXPIRE: { template: "expiring", customerPrefKey: "EXPIRING", salesPrefKey: "EXPIRING", expired: true },
  // Synthetic events written by the cron / API, not state-machine events:
  EXPIRING: { template: "expiring", customerPrefKey: "EXPIRING", salesPrefKey: "EXPIRING" },
  NEW_MESSAGE: { template: "new_message", customerPrefKey: "NEW_MESSAGE", salesPrefKey: "NEW_MESSAGE" },
  FLOOR_APPROVAL_REQUESTED: { template: "floor_approval", customerPrefKey: null, salesPrefKey: "FLOOR_APPROVAL_REQUESTED" },
};

/**
 * Who hears about an event. `actorType` only matters for NEW_MESSAGE (a message from the customer notifies sales and a
 * message from staff notifies the customer; SYSTEM messages notify nobody).
 *
 * Beyond the shared NOTIFY map: SUBMIT also sends the customer a confirmation (screen 5 "Quote received by sales"),
 * governed by the customer's QUOTE_RECEIVED preference; FLOOR_APPROVAL_REQUESTED goes to managers/admins only.
 */
export function planFor(type: string, actorType: "CUSTOMER" | "STAFF" | "SYSTEM"): NotifyPlan | null {
  const t = Object.hasOwn(TEMPLATES, type) ? TEMPLATES[type]! : null;
  if (!t) return null;
  let sides: Side[];
  if (type === "NEW_MESSAGE") {
    if (actorType === "CUSTOMER") sides = ["sales"];
    else if (actorType === "STAFF") sides = ["customer"];
    else return null;
  } else if (type === "EXPIRING") {
    sides = ["customer"];
  } else if (type === "FLOOR_APPROVAL_REQUESTED") {
    sides = ["managers"];
  } else {
    const audience = NOTIFY[type as keyof typeof NOTIFY];
    if (!audience) return null;
    sides = [...SIDES[audience]];
    if (type === "SUBMIT") sides.push("customer");
  }
  return { template: t.template, customerPrefKey: t.customerPrefKey, salesPrefKey: t.salesPrefKey, sides, ...(t.expired ? { expired: true } : {}) };
}
