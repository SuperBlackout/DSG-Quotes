import { describe, expect, it } from "vitest";
import { STAFF_REP, ensureStaff, submitted, useHarness } from "./helpers";

describe("per-quote notification recipients", () => {
  const h = useHarness();
  const base = (id: string) => `/s/quotes/${id}/notification-recipients`;

  it("lists who is notified, adds an email, and removes it", async () => {
    await ensureStaff(h, STAFF_REP);
    const q = await submitted(h);

    const before = await h.s.get(`/s/quotes/${q.id}/notifications`);
    expect(before.status).toBe(200);
    expect(before.body.recipients.some((r: any) => r.who === "Customer")).toBe(true);
    expect(before.body.extras).toEqual([]);

    const bad = await h.s.post(base(q.id), { kind: "EMAIL", address: "not-an-email" });
    expect(bad.status).toBe(422);

    const added = await h.s.post(base(q.id), { kind: "EMAIL", address: "Buyer@Example.com", name: "Bo Buyer" });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ kind: "EMAIL", address: "buyer@example.com", status: "ACTIVE", name: "Bo Buyer" });

    const again = await h.s.post(base(q.id), { kind: "EMAIL", address: "buyer@example.com" });
    expect(again.status).toBe(200);

    const after = await h.s.get(`/s/quotes/${q.id}/notifications`);
    expect(after.body.extras).toHaveLength(1);
    // the extra shows up as a resolved customer-side recipient too, but only once (under extras)
    expect(after.body.recipients.filter((r: any) => r.email === "buyer@example.com")).toHaveLength(0);

    const del = await h.s.del(`${base(q.id)}/${added.body.id}`);
    expect(del.status).toBe(204);
    expect((await h.s.del(`${base(q.id)}/${added.body.id}`)).status).toBe(404);
    expect((await h.s.get(`/s/quotes/${q.id}/notifications`)).body.extras).toEqual([]);
  });

  it("a text number starts PENDING, can be re-sent, and a STOP number is refused", async () => {
    await ensureStaff(h, STAFF_REP);
    const q = await submitted(h);

    expect((await h.s.post(base(q.id), { kind: "SMS", address: "12345" })).status).toBe(422);

    const added = await h.s.post(base(q.id), { kind: "SMS", address: "(516) 555-0142" });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ kind: "SMS", address: "+15165550142", status: "PENDING", requestSent: false });

    const resend = await h.s.post(`${base(q.id)}/${added.body.id}/resend`);
    expect(resend.status).toBe(200);
    expect((await h.s.post(`${base(q.id)}/nope/resend`)).status).toBe(404);

    await h.prisma.smsOptOut.create({ data: { phone: "+15165550199", source: "twilio-stop" } });
    const stopped = await h.s.post(base(q.id), { kind: "SMS", address: "516-555-0199" });
    expect(stopped.status).toBe(422);
    expect(stopped.body.message).toMatch(/STOP/);
  });

  it("an unknown quote is a 404", async () => {
    await ensureStaff(h, STAFF_REP);
    expect((await h.s.get("/s/quotes/nope/notifications")).status).toBe(404);
  });
});
