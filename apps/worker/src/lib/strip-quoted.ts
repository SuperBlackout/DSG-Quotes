/**
 * Strip quoted reply text and signatures noise from an inbound plain-text email, leaving what the person actually wrote.
 * Handles the common clients: Gmail/Apple Mail ("On ... wrote:"), Outlook ("From:/Sent:/To:/Subject:" block,
 * "-----Original Message-----", underscore rule), ">" quoting, mobile signatures, and our own "reply above this line" marker.
 * Inline replies (text interleaved with ">" lines) keep the unquoted lines.
 */
export const REPLY_MARKER = "-- Reply above this line --";

const CUT_LINE: RegExp[] = [
  /^\s*-{2,}\s*Reply above this line\s*-{2,}\s*$/i,
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^\s*-{2,}\s*Forwarded message\s*-{2,}\s*$/i,
  /^\s*_{10,}\s*$/,
  /^\s*On\b.{0,200}\bwrote:\s*$/i, // single line Gmail / Apple Mail
  /^\s*Le\b.{0,200}\bécrit\s*:\s*$/i,
  /^\s*El\b.{0,200}\bescribió:\s*$/i,
];

export function stripQuotedReply(input: string | null | undefined): string {
  if (!input) return "";
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (CUT_LINE.some((re) => re.test(line))) break;
    // "On Mon, Mar 2, 2026 at 3:00 PM Dana <d@x.com>" wrapped onto the next line as "wrote:"
    if (/^\s*On\b/i.test(line) && i + 1 < lines.length && /^\s*.{0,200}\bwrote:\s*$/i.test(lines[i + 1]!) && !/wrote:\s*$/i.test(line)) break;
    // Outlook header block
    if (/^\s*From:\s*\S/i.test(line) && lines.slice(i + 1, i + 6).some((l) => /^\s*(Sent|Date):\s*\S/i.test(l))) break;
    if (/^\s*>/.test(line)) continue; // quoted line
    if (/^\s*Sent from my (iPhone|iPad|Android|Galaxy|mobile|phone)\b/i.test(line)) break;
    if (/^\s*Get Outlook for (iOS|Android)\s*$/i.test(line)) break;
    kept.push(line);
  }
  // A signature delimiter ("-- " on its own line) ends the message.
  const sig = kept.findIndex((l) => /^--\s?$/.test(l));
  const body = (sig >= 0 ? kept.slice(0, sig) : kept).join("\n");
  return body.replace(/\n{3,}/g, "\n\n").trim();
}

/** Very small HTML -> text, only used when a provider sends no text part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
