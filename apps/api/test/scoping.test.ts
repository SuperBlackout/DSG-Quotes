import { describe, expect, it } from "vitest";
import { CUSTOMER_A, CUSTOMER_A_LOC2, CUSTOMER_B, LOC1, LOC2, V_GOOD, customerToken, draftWith, sent, useHarness } from "./helpers";

/** CLAUDE.md rule 3: a customer can never read or touch another company location's quote. Cross-scope = 404. */
describe("company-location scoping", () => {
  const h = useHarness();

  type Call = (id: string, lineId: string, c: ReturnType<typeof h.asCustomer>) => Promise<{ status: number; body: any }>;
  const routes: Record<string, Call> = {
    "GET /c/quotes/:id": (id, _l, c) => c.get(`/c/quotes/${id}`),
    "PATCH /c/quotes/:id": (id, _l, c) => c.patch(`/c/quotes/${id}`, { title: "hijack" }),
    "DELETE /c/quotes/:id": (id, _l, c) => c.del(`/c/quotes/${id}`),
    "POST lines": (id, _l, c) => c.post(`/c/quotes/${id}/lines`, { variantId: V_GOOD, qty: 1 }),
    "PATCH line": (id, l, c) => c.patch(`/c/quotes/${id}/lines/${l}`, { qty: 99 }),
    "DELETE line": (id, l, c) => c.del(`/c/quotes/${id}/lines/${l}`),
    submit: (id, _l, c) => c.post(`/c/quotes/${id}/submit`, {}),
    withdraw: (id, _l, c) => c.post(`/c/quotes/${id}/withdraw`),
    accept: (id, _l, c) => c.post(`/c/quotes/${id}/accept`, {}),
    "request-changes": (id, _l, c) => c.post(`/c/quotes/${id}/request-changes`, { message: "x" }),
    decline: (id, _l, c) => c.post(`/c/quotes/${id}/decline`, {}),
    reopen: (id, _l, c) => c.post(`/c/quotes/${id}/reopen`),
    duplicate: (id, _l, c) => c.post(`/c/quotes/${id}/duplicate`),
    checkout: (id, _l, c) => c.post(`/c/quotes/${id}/checkout`),
    "GET messages": (id, _l, c) => c.get(`/c/quotes/${id}/messages`),
    "POST messages": (id, _l, c) => c.post(`/c/quotes/${id}/messages`, { body: "hi" }),
    "upload-url": (id, _l, c) => c.post(`/c/quotes/${id}/attachments/upload-url`, { name: "a.pdf", size: 1, mime: "application/pdf" }),
    "PUT active-quote": (id, _l, c) => c.put("/c/active-quote", { quoteId: id }),
    "from-cart existing": (id, _l, c) => c.post("/c/quotes/from-cart", { cartLines: [{ variantId: V_GOOD, qty: 1 }], target: { mode: "existing", quoteId: id } }),
  };

  for (const [otherName, other] of [
    ["another company", CUSTOMER_B],
    ["a different location of the SAME company", CUSTOMER_A_LOC2],
  ] as const) {
    describe(`as ${otherName}`, () => {
      for (const [name, call] of Object.entries(routes)) {
        it(`${name} -> 404 and nothing changes`, async () => {
          const q = await sent(h); // QUOTE_READY at LOC1 with a line and a version
          const before = await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
          const eventsBefore = await h.prisma.event.count({ where: { quoteId: q.id } });
          const r = await call(q.id, q.lines[0].id, h.asCustomer(other));
          expect(r.status).toBe(404);
          expect(r.body).toMatchObject({ code: "NOT_FOUND" });
          const after = await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
          expect(after).toEqual(before);
          expect(await h.prisma.event.count({ where: { quoteId: q.id } })).toBe(eventsBefore);
          expect(await h.prisma.message.count({ where: { quoteId: q.id } })).toBe(0);
          expect(h.shopify.createdDraftOrders).toHaveLength(0);
        });
      }

      it("the list never includes foreign quotes, even when filtering by their ids/job/search", async () => {
        const q = await draftWith(h);
        const list = await h.asCustomer(other).get("/c/quotes");
        expect(list.status).toBe(200);
        expect(list.body.items).toEqual([]);
        expect((await h.asCustomer(other).get(`/c/quotes?jobId=${q.job.id}`)).body.items).toEqual([]);
        expect((await h.asCustomer(other).get("/c/quotes?q=Test%20quote")).body.items).toEqual([]);
        expect((await h.asCustomer(other).get("/c/quotes?status=DRAFT")).body.items).toEqual([]);
      });

      it("a job from another location cannot be attached to a new quote", async () => {
        const q = await draftWith(h);
        const r = await h.asCustomer(other).post("/c/quotes", { title: "steal job", jobId: q.job.id });
        expect(r.status).toBe(422);
      });
    });
  }

  it("a foreign customer's active quote is not exposed", async () => {
    const q = await draftWith(h);
    const b = h.asCustomer(CUSTOMER_B);
    expect((await b.get("/c/active-quote")).body.quoteId).toBeNull();
    expect((await h.c.get("/c/active-quote")).body.quoteId).toBe(q.id);
  });

  it("the same company at the SAME location shares quotes; the stored scope is the location, not the customer", async () => {
    const q = await draftWith(h);
    const row = await h.prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
    expect(row.companyLocationId).toBe(LOC1);
    expect(row.customerId).toBe(CUSTOMER_A);
    const colleague = await h.asCustomer("gid://shopify/Customer/1002").get(`/c/quotes/${q.id}`);
    expect(colleague.status).toBe(200);
  });

  it("X-Company-Location-Id picks among the contact's OWN locations only", async () => {
    const buyer = h.shopify.buyers.get(CUSTOMER_A)!;
    buyer.locations = [{ id: LOC1, name: "Main" }, { id: LOC2, name: "Branch" }];
    const q1 = await draftWith(h); // created at the default location LOC1
    const send = (locHeader: string) =>
      h.raw({ method: "GET", url: "/c/quotes", headers: { authorization: `Bearer ${customerToken(CUSTOMER_A, h.clock.now)}`, "x-company-location-id": locHeader } });
    const loc2 = await send(LOC2);
    expect(loc2.body.items).toEqual([]); // LOC2 is permitted but has no quotes
    const loc1 = await send(LOC1);
    expect(loc1.body.items.map((i: any) => i.id)).toEqual([q1.id]);
    const stranger = await send("gid://shopify/CompanyLocation/3"); // not one of the contact's locations -> ignored, default used
    expect(stranger.body.items.map((i: any) => i.id)).toEqual([q1.id]);
    buyer.locations = [{ id: LOC1, name: "Main" }];
  });
});

