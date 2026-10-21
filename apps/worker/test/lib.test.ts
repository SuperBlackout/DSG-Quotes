import { describe, expect, it } from "vitest";
import { inQuietHours, quietEndsAt } from "../src/lib/quiet-hours";
import { normalizePhone, smsKeyword } from "../src/lib/phone";
import { extractEmail, parseReplyAddress, replyAddress } from "../src/lib/reply-token";
import { stripQuotedReply } from "../src/lib/strip-quoted";
import { twilioSignature, verifyTwilioSignature } from "../src/lib/twilio-signature";
import { PostmarkEmailProvider } from "../src/providers/postmark";
import { TwilioSmsProvider } from "../src/providers/twilio";
import { renderEmail, renderSms } from "../src/templates";
import { planFor } from "../src/rules";

describe("reply tokens", () => {
  const a = replyAddress({ secret: "s", domain: "reply.dsg.direct", quoteId: "cmabc123xyz", role: "c" });
  it("round-trips", () => expect(parseReplyAddress(a, "s", "reply.dsg.direct")).toEqual({ quoteId: "cmabc123xyz", role: "c" }));
  it("accepts display-name form and upper case", () => expect(parseReplyAddress(`"Q" <${a.toUpperCase()}>`, "s")).toEqual({ quoteId: "cmabc123xyz", role: "c" }));
  it("rejects wrong secret, tampered quote id, tampered role, wrong domain", () => {
    expect(parseReplyAddress(a, "other")).toBeNull();
    expect(parseReplyAddress(a.replace("cmabc123xyz", "cmabc123xyw"), "s")).toBeNull();
    expect(parseReplyAddress(a.replace("-c", "-s"), "s")).toBeNull();
    expect(parseReplyAddress(a, "s", "evil.com")).toBeNull();
    expect(parseReplyAddress("nobody@reply.dsg.direct", "s")).toBeNull();
  });
  it("extractEmail", () => expect(extractEmail("Dana <Dana@Acme.com>")).toBe("dana@acme.com"));
});

describe("stripQuotedReply", () => {
  it("Gmail", () => expect(stripQuotedReply("Sounds good, accept it.\n\nOn Mon, Mar 2, 2026 at 3:00 PM DSG Quotes <q@dsg.direct> wrote:\n> Your quote is ready\n> link")).toBe("Sounds good, accept it."));
  it("Gmail with wrapped attribution", () => expect(stripQuotedReply("Yes\n\nOn Mon, Mar 2, 2026 at 3:00 PM Someone Long <someone@example.com>\nwrote:\n> hi")).toBe("Yes"));
  it("Outlook", () => expect(stripQuotedReply("Please call me.\n\nFrom: DSG <q@dsg.direct>\nSent: Monday, March 2, 2026 3:00 PM\nTo: Dana\nSubject: Quote\n\nold")).toBe("Please call me."));
  it("Original Message marker, signature and mobile footer", () => {
    expect(stripQuotedReply("ok\n-----Original Message-----\nFrom: x")).toBe("ok");
    expect(stripQuotedReply("ok\n-- \nDana\n555")).toBe("ok");
    expect(stripQuotedReply("ok thanks\n\nSent from my iPhone\n\n> old")).toBe("ok thanks");
  });
  it("keeps inline replies", () => expect(stripQuotedReply("> Can you do 10%?\nYes we can.\n> Ship date?\nFriday.")).toBe("Yes we can.\nFriday."));
  it("our own marker", () => expect(stripQuotedReply("hello\n-- Reply above this line --\nstuff")).toBe("hello"));
  it("empty in, empty out", () => {
    expect(stripQuotedReply("> only quoted")).toBe("");
    expect(stripQuotedReply(null)).toBe("");
  });
});

describe("twilio signature", () => {
  // Expected value computed independently with `openssl dgst -sha1 -hmac` over url + sorted name/value pairs (not a Twilio-published vector).
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" };
  it("matches the documented algorithm and verifies", () => {
    const sig = twilioSignature("12345", url, params);
    expect(sig).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
    expect(verifyTwilioSignature("12345", url, params, sig)).toBe(true);
    expect(verifyTwilioSignature("12345", url, { ...params, Digits: "9" }, sig)).toBe(false);
    expect(verifyTwilioSignature("12345", url, params, undefined)).toBe(false);
  });
});

describe("phone and keywords", () => {
  it("normalises", () => {
    expect(normalizePhone("(312) 555-0123")).toBe("+13125550123");
    expect(normalizePhone("+1 312 555 0123")).toBe("+13125550123");
    expect(normalizePhone("123")).toBeNull();
  });
  it("STOP/HELP/START, whole message only", () => {
    expect(smsKeyword(" stop ")).toBe("STOP");
    expect(smsKeyword("Unsubscribe.")).toBe("STOP");
    expect(smsKeyword("HELP")).toBe("HELP");
    expect(smsKeyword("start")).toBe("START");
    expect(smsKeyword("please stop the price at 10")).toBeNull();
  });
});

describe("quiet hours", () => {
  const w = { start: "19:00", end: "07:00", tz: "America/New_York" };
  it("wraps midnight", () => {
    expect(inQuietHours(new Date("2026-03-03T01:00:00Z"), w)).toBe(true); // 20:00 ET
    expect(inQuietHours(new Date("2026-03-03T10:00:00Z"), w)).toBe(true); // 05:00 ET
    expect(inQuietHours(new Date("2026-03-02T15:00:00Z"), w)).toBe(false); // 10:00 ET
  });
  it("ends at the next 07:00 local", () => {
    expect(quietEndsAt(new Date("2026-03-03T01:00:00Z"), w).toISOString()).toBe("2026-03-03T12:00:00.000Z");
    expect(quietEndsAt(new Date("2026-03-03T10:00:00Z"), w).toISOString()).toBe("2026-03-03T12:00:00.000Z");
  });
  it("handles DST (clocks go forward 8 Mar 2026 02:00)", () => {
    expect(quietEndsAt(new Date("2026-03-08T03:00:00Z"), w).toISOString()).toBe("2026-03-08T11:00:00.000Z"); // 07:00 EDT
  });
  it("no window configured = never quiet", () => expect(inQuietHours(new Date(), { start: null, end: null, tz: null })).toBe(false));
});

describe("provider request shapes (fake fetch; NOT live)", () => {
  it("Postmark", async () => {
    let seen: any;
    const p = new PostmarkEmailProvider("tok", { fetch: (async (url: string, init: any) => ((seen = { url, init }), new Response(JSON.stringify({ ErrorCode: 0, MessageID: "pm-1" }), { status: 200 }))) as any });
    const r = await p.send({ from: "a@x.com", to: "b@y.com", subject: "S", text: "T", html: "<p>T</p>", replyTo: "q@r.com", tag: "t" });
    expect(r.providerId).toBe("pm-1");
    expect(seen.url).toBe("https://api.postmarkapp.com/email");
    expect(seen.init.headers["X-Postmark-Server-Token"]).toBe("tok");
    expect(JSON.parse(seen.init.body)).toMatchObject({ From: "a@x.com", To: "b@y.com", ReplyTo: "q@r.com", Subject: "S" });
  });
  it("Postmark errors classify retryable vs permanent", async () => {
    const mk = (status: number) => new PostmarkEmailProvider("t", { fetch: (async () => new Response(JSON.stringify({ ErrorCode: 406, Message: "inactive" }), { status })) as any });
    await expect(mk(422).send({ from: "a", to: "b", subject: "", text: "", html: "" })).rejects.toMatchObject({ retryable: false });
    await expect(mk(503).send({ from: "a", to: "b", subject: "", text: "", html: "" })).rejects.toMatchObject({ retryable: true });
  });
  it("Twilio", async () => {
    let seen: any;
    const p = new TwilioSmsProvider({ accountSid: "AC1", authToken: "tk", messagingServiceSid: "MG1" }, { fetch: (async (url: string, init: any) => ((seen = { url, init }), new Response(JSON.stringify({ sid: "SM1" }), { status: 201 }))) as any });
    expect((await p.send({ to: "+13125550123", body: "hi" })).providerId).toBe("SM1");
    expect(seen.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json");
    expect(seen.init.headers.Authorization).toBe(`Basic ${Buffer.from("AC1:tk").toString("base64")}`);
    const form = new URLSearchParams(seen.init.body);
    expect(form.get("MessagingServiceSid")).toBe("MG1");
    expect(form.get("To")).toBe("+13125550123");
  });
});

describe("rules and templates", () => {
  it("audiences follow the shared NOTIFY map", () => {
    expect(planFor("SEND_REVISION", "STAFF")!.sides).toEqual(["customer"]);
    expect(planFor("ACCEPT", "CUSTOMER")!.sides.sort()).toEqual(["customer", "sales"]);
    expect(planFor("EXPIRE", "SYSTEM")!.sides).toEqual(["customer"]);
    expect(planFor("NEW_MESSAGE", "SYSTEM")).toBeNull();
    expect(planFor("toString", "SYSTEM")).toBeNull();
  });
  it("html is escaped and SMS stays short", () => {
    const ctx = { template: "new_message" as const, side: "sales" as const, number: 1, title: "t", customerName: "D", companyName: null, version: 1, total: null, expiresAt: null, link: "https://x/y", canReplyByEmail: true, messages: [{ author: "<b>x</b>", body: "<script>1</script>", at: new Date() }] };
    expect(renderEmail(ctx).html).not.toContain("<script>");
    expect(renderSms(ctx).length).toBeLessThan(160);
  });
});
