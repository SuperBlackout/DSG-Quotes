import { NOTIFY } from "shared";

/** Notification templates = the rows of the plan's Notifications table. */
export type Template = "submitted" | "quote_ready" | "new_message" | "changes_requested" | "accepted" | "ordered" | "expiring";
export type Side = "customer" | "sales";

export interface NotifyPlan {
  template: Template;
  /** Key used in NotificationPref.event (customer settings screen / staff prefs). */
  prefKey: string;
  sides: Side[];
  /** EXPIRE (already lapsed) rather than EXPIRING (3 days left): same template, different wording. */
  expired?: boolean;
}

const SIDES = { sales: ["sales"], customer: ["customer"], both: ["customer", "sales"] } as const;

/** Event type -> template and preference key. The audience comes from the shared NOTIFY map. */
const TEMPLATES: Record<string, { template: Template; prefKey: string; expired?: boolean }> = {
  SUBMIT: { template: "submitted", prefKey: "SUBMITTED" },
  SEND_REVISION: { template: "quote_ready", prefKey: "QUOTE_READY" },
  REQUEST_CHANGES: { template: "changes_requested", prefKey: "CHANGES_REQUESTED" },
  ACCEPT: { template: "accepted", prefKey: "ACCEPTED" },
  ORDER_PLACED: { template: "ordered", prefKey: "ORDERED" },
  EXPIRE: { template: "expiring", prefKey: "EXPIRING", expired: true },
  // Synthetic events written by the cron / API, not state-machine events:
  EXPIRING: { template: "expiring", prefKey: "EXPIRING" },
  NEW_MESSAGE: { template: "new_message", prefKey: "NEW_MESSAGE" },
};

/**
 * Who hears about an event. `actorType` only matters for NEW_MESSAGE (a message from the customer notifies sales and a
 * message from staff notifies the customer; SYSTEM messages notify nobody).
 *
 * Beyond the shared NOTIFY map: SUBMIT also sends the customer a confirmation (screen 5 "Quote received by sales",
 * "Confirmation after you submit"), governed by the customer's SUBMITTED preference.
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
  } else {
    const audience = NOTIFY[type as keyof typeof NOTIFY];
    if (!audience) return null;
    sides = [...SIDES[audience]];
    if (type === "SUBMIT") sides.push("customer");
  }
  return { template: t.template, prefKey: t.prefKey, sides, ...(t.expired ? { expired: true } : {}) };
}
