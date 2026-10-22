// Quote state machine — the ONLY place quote status may change.
// Every successful transition must be persisted together with an `events` row
// (the API wraps transition() + prisma writes in one transaction).

export type QuoteStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "IN_REVIEW"
  | "QUOTE_READY"
  | "CHANGES_REQUESTED"
  | "ACCEPTED"
  | "ORDERED"
  | "EXPIRED"
  | "DECLINED"
  | "ARCHIVED";

export type QuoteEvent =
  | "SUBMIT" // customer sends draft to sales
  | "WITHDRAW" // customer pulls a submitted quote back to draft
  | "CLAIM" // rep picks it up
  | "SEND_REVISION" // rep sends vN to customer
  | "REQUEST_CHANGES" // customer asks for changes
  | "ACCEPT" // customer accepts current version
  | "REOPEN" // rep or customer reopens an accepted quote (new revision)
  | "ORDER_PLACED" // orders/create webhook for the linked draft order
  | "EXPIRE" // cron: expires_at passed
  | "DECLINE" // customer or rep closes it
  | "DELETE"; // customer deletes a draft (soft delete → ARCHIVED)

export type Actor = "customer" | "staff" | "system";

type Rule = { to: QuoteStatus; by: Actor[] };

const RULES: Record<QuoteStatus, Partial<Record<QuoteEvent, Rule>>> = {
  DRAFT: {
    SUBMIT: { to: "SUBMITTED", by: ["customer", "staff"] },
    // Rep-created quotes start as DRAFT with no customer submission; the rep prices and sends them directly.
    SEND_REVISION: { to: "QUOTE_READY", by: ["staff"] },
    DELETE: { to: "ARCHIVED", by: ["customer"] },
  },
  SUBMITTED: {
    WITHDRAW: { to: "DRAFT", by: ["customer"] },
    CLAIM: { to: "IN_REVIEW", by: ["staff"] },
    SEND_REVISION: { to: "QUOTE_READY", by: ["staff"] },
    DECLINE: { to: "DECLINED", by: ["customer", "staff"] },
  },
  IN_REVIEW: {
    SEND_REVISION: { to: "QUOTE_READY", by: ["staff"] },
    DECLINE: { to: "DECLINED", by: ["customer", "staff"] },
  },
  QUOTE_READY: {
    ACCEPT: { to: "ACCEPTED", by: ["customer"] },
    REQUEST_CHANGES: { to: "CHANGES_REQUESTED", by: ["customer"] },
    SEND_REVISION: { to: "QUOTE_READY", by: ["staff"] },
    EXPIRE: { to: "EXPIRED", by: ["system"] },
    DECLINE: { to: "DECLINED", by: ["customer", "staff"] },
  },
  CHANGES_REQUESTED: {
    CLAIM: { to: "IN_REVIEW", by: ["staff"] },
    SEND_REVISION: { to: "QUOTE_READY", by: ["staff"] },
    DECLINE: { to: "DECLINED", by: ["customer", "staff"] },
  },
  ACCEPTED: {
    ORDER_PLACED: { to: "ORDERED", by: ["system"] },
    REOPEN: { to: "IN_REVIEW", by: ["staff", "customer"] },
    EXPIRE: { to: "EXPIRED", by: ["system"] },
  },
  ORDERED: {},
  EXPIRED: {},
  DECLINED: {},
  ARCHIVED: {},
};

export class TransitionError extends Error {
  override name = "TransitionError";
}

/**
 * Own-property lookup only. A plain `RULES[from][event]` would resolve inherited keys such as
 * "toString" / "constructor" (events arrive as untrusted strings over HTTP), yielding a truthy
 * non-rule and a TypeError instead of a TransitionError / `false`.
 */
function ruleFor(from: QuoteStatus, event: QuoteEvent): Rule | undefined {
  const table = Object.hasOwn(RULES, from) ? RULES[from] : undefined;
  return table && Object.hasOwn(table, event) ? table[event] : undefined;
}

export function canTransition(from: QuoteStatus, event: QuoteEvent, actor: Actor): boolean {
  const rule = ruleFor(from, event);
  return !!rule && rule.by.includes(actor);
}

export function transition(from: QuoteStatus, event: QuoteEvent, actor: Actor): QuoteStatus {
  const rule = ruleFor(from, event);
  if (!rule) throw new TransitionError(`${event} is not allowed from ${from}`);
  if (!rule.by.includes(actor)) throw new TransitionError(`${actor} cannot ${event} from ${from}`);
  return rule.to;
}

/** Purchase guard — the API calls this before creating a draft order. */
export function isPurchasable(status: QuoteStatus, expiresAt: Date | null, now = new Date()): boolean {
  return status === "ACCEPTED" && (!expiresAt || expiresAt.getTime() > now.getTime());
}

/** Customer may add/remove lines only on drafts. */
export function customerCanEditLines(status: QuoteStatus): boolean {
  return status === "DRAFT";
}

/** Which side owes the next action — drives inbox tabs and the "Waiting on you" filter. */
export function waitingOn(status: QuoteStatus): "customer" | "sales" | "none" {
  switch (status) {
    case "DRAFT":
    case "QUOTE_READY":
    case "ACCEPTED":
      return "customer";
    case "SUBMITTED":
    case "IN_REVIEW":
    case "CHANGES_REQUESTED":
      return "sales";
    default:
      return "none";
  }
}

/** Event → default notification audience. The worker joins this with notification_prefs. */
export const NOTIFY: Partial<Record<QuoteEvent, "sales" | "customer" | "both">> = {
  SUBMIT: "sales",
  REQUEST_CHANGES: "sales",
  SEND_REVISION: "customer",
  ACCEPT: "both",
  ORDER_PLACED: "both",
  EXPIRE: "customer",
};
