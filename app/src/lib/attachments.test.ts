import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENT_BYTES, uploadAttachment, validateAttachment } from "./attachments";

const target = { uploadUrl: "https://files.example/put?sig=1", fileUrl: "https://files.example/q1/a.pdf", expiresAt: "2026-10-21T13:00:00Z" };

describe("staff attachments", () => {
  it("requests an upload url, PUTs the file, and returns the attachment with fileUrl", async () => {
    const requests: unknown[] = [];
    const api = {
      createAttachmentUpload: async (id: string, body: { name: string; size: number; mime: string }) => {
        requests.push([id, body]);
        return target;
      },
    };
    const puts: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      puts.push({ url, init });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const att = await uploadAttachment(api, "q1", { name: "a.pdf", size: 10, type: "application/pdf" }, "0123456789", f);
    expect(requests).toEqual([["q1", { name: "a.pdf", size: 10, mime: "application/pdf" }]]);
    expect(puts[0]!.url).toBe(target.uploadUrl);
    expect(puts[0]!.init.method).toBe("PUT");
    expect((puts[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/pdf");
    expect(att).toEqual({ url: target.fileUrl, name: "a.pdf", size: 10, mime: "application/pdf" });
  });

  it("defaults the mime type and reports a failed PUT", async () => {
    const api = { createAttachmentUpload: async () => target };
    const f = (async () => new Response(null, { status: 403 })) as unknown as typeof fetch;
    await expect(uploadAttachment(api, "q1", { name: "x.bin", size: 1, type: "" }, "x", f)).rejects.toThrow(/failed \(403\)/);
  });

  it("rejects empty and oversized files before asking the API", async () => {
    expect(validateAttachment({ name: "a", size: 0 })).toMatch(/empty/);
    expect(validateAttachment({ name: "a", size: MAX_ATTACHMENT_BYTES + 1 })).toMatch(/25 MB/);
    expect(validateAttachment({ name: "a", size: 5 })).toBeNull();
    let called = false;
    const api = {
      createAttachmentUpload: async () => {
        called = true;
        return target;
      },
    };
    await expect(uploadAttachment(api, "q1", { name: "a", size: 0, type: "" }, "")).rejects.toThrow(/empty/);
    expect(called).toBe(false);
  });
});
