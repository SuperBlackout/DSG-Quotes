/**
 * Staff message attachments: ask the API for a signed upload URL, PUT the file there, then send the returned
 * `fileUrl` as the attachment `url` on `POST /s/quotes/{id}/messages`.
 */
import type { Attachment, StaffClient } from "./api-client";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function validateAttachment(file: { name: string; size: number }): string | null {
  if (file.size <= 0) return `${file.name} is empty.`;
  if (file.size > MAX_ATTACHMENT_BYTES) return `${file.name} is larger than 25 MB.`;
  return null;
}

export async function uploadAttachment(
  api: Pick<StaffClient, "createAttachmentUpload">,
  quoteId: string,
  file: { name: string; size: number; type: string },
  body: BodyInit,
  doFetch: typeof fetch = (...a) => fetch(...a),
): Promise<Attachment> {
  const problem = validateAttachment(file);
  if (problem) throw new Error(problem);
  const mime = file.type || "application/octet-stream";
  const target = await api.createAttachmentUpload(quoteId, { name: file.name, size: file.size, mime });
  const res = await doFetch(target.uploadUrl, { method: "PUT", headers: { "Content-Type": mime }, body });
  if (!res.ok) throw new Error(`Upload of ${file.name} failed (${res.status}).`);
  return { url: target.fileUrl, name: file.name, size: file.size, mime };
}
