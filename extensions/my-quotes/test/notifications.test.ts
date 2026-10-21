import { describe, expect, it } from "vitest";
import { SMS_CONSENT_TEXT, consentPayload } from "../src/lib/consent";
import {
  EVENT_DEFS,
  EVENT_KEYS,
  describeWatcher,
  emptyWatcher,
  scopeOptions,
  watcherToPut,
  type WatcherForm,
  formFromPrefs,
  formatPhone,
  formatTime,
  normalizePhone,
  prefsToPut,
  timeOptions,
  validatePrefs,
} from "../src/lib/notifications";
import type { NotificationPrefs } from "../src/api/types";
import { prefs } from "./fixtures";

describe("SMS consent text", () => {
  it("is exactly the wording on mockup screen 5 (and the Twilio A2P campaign)", () => {
    expect(SMS_CONSENT_TEXT).toBe(
      "I agree to receive quote alerts by text from DSG Distributors. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.",
    );
  });

  it("contains the carrier-required disclosures", () => {
    for (const phrase of ["DSG Distributors", "Msg frequency varies", "Msg & data rates may apply", "Reply STOP", "HELP"]) {
      expect(SMS_CONSENT_TEXT).toContain(phrase);
    }
  });

  it("is sent with the opt-in, and only with the opt-in", () => {
    expect(consentPayload(true)).toEqual({ smsOptIn: true, smsConsentText: SMS_CONSENT_TEXT });
    expect(consentPayload(false)).toEqual({ smsOptIn: false });
    expect("smsConsentText" in consentPayload(false)).toBe(false);
  });
});

describe("phone helpers", () => {
  it.each([
    ["(516) 555-0142", "+15165550142"],
    ["516-555-0142", "+15165550142"],
    ["1 516 555 0142", "+15165550142"],
    ["+44 20 7946 0958", "+442079460958"],
  ])("normalizes %s", (input, out) => expect(normalizePhone(input)).toBe(out));

  it.each(["", "555-0142", "12345", "+1", "abc"])("rejects %j", (input) => expect(normalizePhone(input)).toBeNull());

  it("formats US numbers back for display", () => {
    expect(formatPhone("+15165550142")).toBe("(516) 555-0142");
    expect(formatPhone("+442079460958")).toBe("+442079460958");
  });
});

describe("form <-> prefs", () => {
  it("renders exactly the seven contract events with friendly labels", () => {
    expect(EVENT_DEFS.map((d) => [d.key, d.title])).toEqual([
      ["QUOTE_RECEIVED", "Quote received"],
      ["QUOTE_READY", "Quote ready"],
      ["NEW_MESSAGE", "New message"],
      ["EXPIRING", "Expiring soon"],
      ["ORDERED", "Ordered"],
      ["ACCEPTED", "Accepted"],
      ["WEEKLY_SUMMARY", "Weekly summary"],
    ]);
    expect([...EVENT_KEYS].sort()).toEqual(
      ["ACCEPTED", "EXPIRING", "NEW_MESSAGE", "ORDERED", "QUOTE_READY", "QUOTE_RECEIVED", "WEEKLY_SUMMARY"],
    );
  });

  it("forces WEEKLY_SUMMARY to email only", () => {
    const p = prefs();
    const f = formFromPrefs({ ...p, events: { ...p.events, WEEKLY_SUMMARY: { email: true, sms: true } } });
    expect(f.events.WEEKLY_SUMMARY).toEqual({ email: true, sms: false });
  });

  it("fills missing events (older server data) with everything off", () => {
    const partial = { ...prefs(), events: {} } as unknown as NotificationPrefs;
    expect(formFromPrefs(partial).events.QUOTE_READY).toEqual({ email: false, sms: false });
  });

  it("loads rich watchers", () => {
    expect(formFromPrefs(prefs()).watchers).toEqual([
      { email: "sam@example.com", name: "Sam Lee", role: "Project manager", scope: "all", channels: { email: true, sms: false } },
    ]);
    const bare = formFromPrefs(prefs({ watchers: [{ email: "a@b.co", scope: "job9", channels: { email: true, sms: true } }] }));
    expect(bare.watchers[0]).toMatchObject({ name: "", role: "", scope: "job9" });
  });

  it("derives quiet hours switch from the stored times and defaults to 7 PM - 7 AM", () => {
    expect(formFromPrefs(prefs()).quietEnabled).toBe(true);
    const off = formFromPrefs(prefs({ quietStart: null, quietEnd: null }));
    expect(off).toMatchObject({ quietEnabled: false, quietStart: "19:00", quietEnd: "07:00" });
  });

  it("displays the stored phone formatted", () => {
    expect(formFromPrefs(prefs()).phone).toBe("(516) 555-0142");
  });
});

describe("validatePrefs", () => {
  const base = () => formFromPrefs(prefs());

  it("accepts the mockup state", () => {
    expect(validatePrefs(base())).toEqual({});
  });

  it("requires a valid email", () => {
    expect(validatePrefs({ ...base(), email: "nope" }).email).toBeDefined();
  });

  it("requires opt-in before any text event can be on", () => {
    expect(validatePrefs({ ...base(), smsOptIn: false }).smsOptIn).toBeDefined();
  });

  it("allows email-only settings without a phone or opt-in", () => {
    const f = base();
    for (const k of EVENT_KEYS) f.events[k] = { email: true, sms: false };
    expect(validatePrefs({ ...f, smsOptIn: false, phone: "" })).toEqual({});
  });

  it("requires a valid mobile number when opted in or when texts are on", () => {
    expect(validatePrefs({ ...base(), phone: "12" }).phone).toBeDefined();
    expect(validatePrefs({ ...base(), phone: "" }).phone).toBeDefined();
  });

  const w = (over: Partial<WatcherForm> = {}): WatcherForm => ({ ...emptyWatcher(), email: "a@b.co", ...over });

  it("rejects bad watcher emails and watchers with no channel", () => {
    expect(validatePrefs({ ...base(), watchers: [w({ email: "x" })] }).watchers).toBeDefined();
    expect(
      validatePrefs({ ...base(), watchers: [w({ channels: { email: false, sms: false } })] }).watchers,
    ).toMatch(/email or text/);
  });

  it("rejects the same person twice for the same scope but allows different scopes", () => {
    expect(validatePrefs({ ...base(), watchers: [w(), w({ email: "A@B.co" })] }).watchers).toMatch(/twice/);
    expect(validatePrefs({ ...base(), watchers: [w(), w({ scope: "job1" })] }).watchers).toBeUndefined();
  });
});

describe("prefsToPut", () => {
  it("writes the consent text exactly and never sends the read-only smsOptInAt", () => {
    const original = prefs();
    const body = prefsToPut(original, formFromPrefs(original));
    expect(body.smsOptIn).toBe(true);
    expect(body.smsConsentText).toBe(SMS_CONSENT_TEXT);
    expect("smsOptInAt" in body).toBe(false);
  });

  it("normalizes the phone to E.164", () => {
    const original = prefs();
    const f = { ...formFromPrefs(original), phone: "(516) 555-0199" };
    expect(prefsToPut(original, f).phone).toBe("+15165550199");
  });

  it("keeps event keys this page does not show (ACCEPTED) so a save does not drop them", () => {
    const original = prefs();
    const f = formFromPrefs(original);
    f.events.QUOTE_READY = { email: false, sms: false };
    const body = prefsToPut(original, f);
    expect(body.events.ACCEPTED).toEqual({ email: true, sms: false });
    expect(body.events.QUOTE_READY).toEqual({ email: false, sms: false });
  });

  it("clears quiet hours when switched off, keeps timezone", () => {
    const original = prefs();
    const body = prefsToPut(original, { ...formFromPrefs(original), quietEnabled: false });
    expect(body.quietStart).toBeNull();
    expect(body.quietEnd).toBeNull();
    expect(body.timezone).toBe("America/New_York");
  });

  it("opt-out sends smsOptIn false without consent text", () => {
    const original = prefs();
    const f = formFromPrefs(original);
    for (const k of EVENT_KEYS) f.events[k] = { email: true, sms: false };
    const body = prefsToPut(original, { ...f, smsOptIn: false });
    expect(body.smsOptIn).toBe(false);
    expect(body.smsConsentText).toBeUndefined();
  });

  it("trims emails and sends rich watchers, omitting empty name and role", () => {
    const original = prefs();
    const watchers: WatcherForm[] = [
      { email: " sam@example.com", name: " Sam Lee ", role: "", scope: "job1", channels: { email: true, sms: true } },
    ];
    const body = prefsToPut(original, { ...formFromPrefs(original), email: " dana@example.com ", watchers });
    expect(body.email).toBe("dana@example.com");
    expect(body.watchers).toEqual([
      { email: "sam@example.com", name: "Sam Lee", scope: "job1", channels: { email: true, sms: true } },
    ]);
    expect("role" in body.watchers![0]!).toBe(false);
  });

  it("sends exactly the seven event keys, nothing else (PUT replaces all, unknown keys are rejected)", () => {
    const original = { ...prefs(), events: { ...prefs().events, CHANGES_REQUESTED: { email: true, sms: true } } } as unknown as NotificationPrefs;
    const body = prefsToPut(original, formFromPrefs(original));
    expect(Object.keys(body.events).sort()).toEqual([...EVENT_KEYS].sort());
  });

  it("keeps a watcher's scope when its job is not in the loaded job list", () => {
    const original = prefs({ watchers: [{ email: "a@b.co", scope: "job-gone", channels: { email: true, sms: false } }] });
    const body = prefsToPut(original, formFromPrefs(original));
    expect(body.watchers![0]!.scope).toBe("job-gone");
  });
});

describe("watcher scope", () => {
  it("offers All quotes first, then jobs, then unknown scopes already on a watcher", () => {
    const f = formFromPrefs(prefs({ watchers: [{ email: "a@b.co", scope: "job-gone", channels: { email: true, sms: false } }] }));
    const opts = scopeOptions([{ id: "job1", name: "Lakeview Clinic" }], f.watchers);
    expect(opts).toEqual([
      { value: "all", label: "All quotes" },
      { value: "job1", label: "Job: Lakeview Clinic" },
      { value: "job-gone", label: "A specific job" },
    ]);
  });

  it("describes a watcher on one line", () => {
    const opts = scopeOptions([{ id: "job1", name: "Lakeview Clinic" }], []);
    const text = describeWatcher(
      { email: "a@b.co", name: "", role: "Foreman", scope: "job1", channels: { email: true, sms: true } },
      opts,
    );
    expect(text).toBe("Foreman · Job: Lakeview Clinic · Email + Text");
  });

  it("watcherToPut defaults an empty scope to all", () => {
    expect(watcherToPut({ ...emptyWatcher(), email: "a@b.co", scope: "" }).scope).toBe("all");
  });
});

describe("time options", () => {
  it("has a slot every half hour and friendly labels", () => {
    const opts = timeOptions();
    expect(opts).toHaveLength(48);
    expect(opts.find((o) => o.value === "19:00")?.label).toBe("7:00 PM");
    expect(opts.find((o) => o.value === "00:00")?.label).toBe("12:00 AM");
    expect(formatTime("12:30")).toBe("12:30 PM");
  });
});
