import { describe, expect, it } from "vitest";
import {
  NOTIFY,
  TransitionError,
  canTransition,
  customerCanEditLines,
  isPurchasable,
  transition,
  waitingOn,
  type Actor,
  type QuoteEvent,
  type QuoteStatus,
} from "../src/quote-state";

const STATUSES: QuoteStatus[] = [
  "DRAFT", "SUBMITTED", "IN_REVIEW", "QUOTE_READY", "CHANGES_REQUESTED",
  "ACCEPTED", "ORDERED", "EXPIRED", "DECLINED", "ARCHIVED",
];
const EVENTS: QuoteEvent[] = [
  "SUBMIT", "WITHDRAW", "CLAIM", "SEND_REVISION", "REQUEST_CHANGES", "ACCEPT",
  "REOPEN", "ORDER_PLACED", "EXPIRE", "DECLINE", "DELETE",
];
const ACTORS: Actor[] = ["customer", "staff", "system"];

// Independent, hand-written expectation table: status -> event -> [target, allowed actors].
// Deliberately NOT derived from the implementation so the test is a real second source of truth.
const C = "customer", S = "staff", Y = "system";
const EXPECTED: Record<string, Record<string, [QuoteStatus, Actor[]]>> = {
  DRAFT: { SUBMIT: ["SUBMITTED", [C, S]], SEND_REVISION: ["QUOTE_READY", [S]], DELETE: ["ARCHIVED", [C]] },
  SUBMITTED: {
    WITHDRAW: ["DRAFT", [C]], CLAIM: ["IN_REVIEW", [S]],
    SEND_REVISION: ["QUOTE_READY", [S]], DECLINE: ["DECLINED", [C, S]],
  },
  IN_REVIEW: { SEND_REVISION: ["QUOTE_READY", [S]], DECLINE: ["DECLINED", [C, S]] },
  QUOTE_READY: {
    ACCEPT: ["ACCEPTED", [C]], REQUEST_CHANGES: ["CHANGES_REQUESTED", [C]],
    SEND_REVISION: ["QUOTE_READY", [S]], EXPIRE: ["EXPIRED", [Y]], DECLINE: ["DECLINED", [C, S]],
  },
  CHANGES_REQUESTED: {
    CLAIM: ["IN_REVIEW", [S]], SEND_REVISION: ["QUOTE_READY", [S]], DECLINE: ["DECLINED", [C, S]],
  },
  ACCEPTED: {
    ORDER_PLACED: ["ORDERED", [Y]], REOPEN: ["IN_REVIEW", [S, C]], EXPIRE: ["EXPIRED", [Y]],
  },
  ORDERED: {}, EXPIRED: {}, DECLINED: {}, ARCHIVED: {},
};

describe("transition: exhaustive status x event x actor", () => {
  for (const status of STATUSES) {
    for (const event of EVENTS) {
      for (const actor of ACTORS) {
        const rule = EXPECTED[status]?.[event];
        const allowed = !!rule && rule[1].includes(actor);
        it(`${status} + ${event} by ${actor} -> ${allowed ? rule![0] : "refused"}`, () => {
          expect(canTransition(status, event, actor)).toBe(allowed);
          if (allowed) {
            expect(transition(status, event, actor)).toBe(rule![0]);
          } else {
            expect(() => transition(status, event, actor)).toThrow(TransitionError);
          }
        });
      }
    }
  }

  it("covers all 10 x 11 x 3 = 330 combinations", () => {
    expect(STATUSES.length * EVENTS.length * ACTORS.length).toBe(330);
  });
});

describe("terminal states", () => {
  for (const status of ["ORDERED", "EXPIRED", "DECLINED", "ARCHIVED"] as const) {
    it(`${status} accepts no events from anyone`, () => {
      for (const e of EVENTS) for (const a of ACTORS) expect(canTransition(status, e, a)).toBe(false);
    });
  }
});

describe("error handling", () => {
  it("messages name the event/actor/status", () => {
    expect(() => transition("DRAFT", "ACCEPT", "customer")).toThrow(/ACCEPT is not allowed from DRAFT/);
    expect(() => transition("QUOTE_READY", "ACCEPT", "staff")).toThrow(/staff cannot ACCEPT from QUOTE_READY/);
  });
  it("TransitionError is identifiable", () => {
    try { transition("ORDERED", "SUBMIT", "customer"); } catch (e) {
      expect(e).toBeInstanceOf(TransitionError);
      expect((e as Error).name).toBe("TransitionError");
    }
  });
  it("untrusted strings that match Object.prototype keys are refused cleanly (regression)", () => {
    for (const bad of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(canTransition("DRAFT", bad as QuoteEvent, "customer")).toBe(false);
      expect(() => transition("DRAFT", bad as QuoteEvent, "customer")).toThrow(TransitionError);
    }
    expect(() => transition("constructor" as QuoteStatus, "SUBMIT", "customer")).toThrow(TransitionError);
  });
  it("unknown actor is refused", () => {
    expect(canTransition("DRAFT", "SUBMIT", "robot" as Actor)).toBe(false);
  });
});

describe("lifecycle happy paths", () => {
  it("draft -> ordered", () => {
    let s: QuoteStatus = "DRAFT";
    s = transition(s, "SUBMIT", "customer");
    s = transition(s, "CLAIM", "staff");
    s = transition(s, "SEND_REVISION", "staff");
    s = transition(s, "REQUEST_CHANGES", "customer");
    s = transition(s, "CLAIM", "staff");
    s = transition(s, "SEND_REVISION", "staff");
    s = transition(s, "ACCEPT", "customer");
    s = transition(s, "ORDER_PLACED", "system");
    expect(s).toBe("ORDERED");
  });
  it("accepted can be reopened and re-quoted", () => {
    let s: QuoteStatus = "ACCEPTED";
    s = transition(s, "REOPEN", "customer");
    expect(s).toBe("IN_REVIEW");
    expect(transition(s, "SEND_REVISION", "staff")).toBe("QUOTE_READY");
  });
  it("withdraw returns to draft and can be resubmitted", () => {
    expect(transition(transition("DRAFT", "SUBMIT", "customer"), "WITHDRAW", "customer")).toBe("DRAFT");
  });
});

describe("isPurchasable", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  const future = new Date("2026-06-15T00:00:00Z");
  const past = new Date("2026-05-01T00:00:00Z");

  for (const status of STATUSES) {
    it(`${status}: ${status === "ACCEPTED" ? "purchasable" : "not purchasable"} (future/null expiry)`, () => {
      expect(isPurchasable(status, future, now)).toBe(status === "ACCEPTED");
      expect(isPurchasable(status, null, now)).toBe(status === "ACCEPTED");
    });
    it(`${status}: never purchasable once expired`, () => {
      expect(isPurchasable(status, past, now)).toBe(false);
    });
  }
  it("expiry boundary: exactly now is expired, 1ms later is valid", () => {
    expect(isPurchasable("ACCEPTED", new Date(now.getTime()), now)).toBe(false);
    expect(isPurchasable("ACCEPTED", new Date(now.getTime() + 1), now)).toBe(true);
  });
  it("defaults now to the current time", () => {
    expect(isPurchasable("ACCEPTED", new Date(Date.now() + 60_000))).toBe(true);
    expect(isPurchasable("ACCEPTED", new Date(Date.now() - 60_000))).toBe(false);
  });
});

describe("customerCanEditLines", () => {
  for (const status of STATUSES) {
    it(`${status}`, () => expect(customerCanEditLines(status)).toBe(status === "DRAFT"));
  }
});

describe("waitingOn", () => {
  const exp: Record<QuoteStatus, "customer" | "sales" | "none"> = {
    DRAFT: "customer", QUOTE_READY: "customer", ACCEPTED: "customer",
    SUBMITTED: "sales", IN_REVIEW: "sales", CHANGES_REQUESTED: "sales",
    ORDERED: "none", EXPIRED: "none", DECLINED: "none", ARCHIVED: "none",
  };
  for (const status of STATUSES) {
    it(`${status} -> ${exp[status]}`, () => expect(waitingOn(status)).toBe(exp[status]));
  }
});

describe("NOTIFY map", () => {
  it("only references real events and never targets internal-only audiences", () => {
    for (const [event, aud] of Object.entries(NOTIFY)) {
      expect(EVENTS).toContain(event);
      expect(["sales", "customer", "both"]).toContain(aud);
    }
  });
  it("every notified event is reachable by some transition", () => {
    for (const event of Object.keys(NOTIFY)) {
      const reachable = STATUSES.some((s) => ACTORS.some((a) => canTransition(s, event as QuoteEvent, a)));
      expect(reachable).toBe(true);
    }
  });
});
