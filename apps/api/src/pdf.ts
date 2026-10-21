import type { Schemas } from "shared";

/**
 * Minimal dependency-free PDF writer for the customer quote PDF (GET /c/quotes/{id}/pdf).
 *
 * It takes ONLY the customer-safe serializer output (`CustomerQuote` + one `CustomerQuoteVersion`), so cost, margin,
 * floor flags and internal notes cannot reach the document (CLAUDE.md rules 4 and 5). Text is set in the standard
 * Helvetica fonts (WinAnsi); characters outside Latin-1 print as "?".
 */

const PAGE_W = 612; // US Letter, points
const PAGE_H = 792;
const MARGIN = 50;
const BOTTOM = 60;

type Font = "F1" | "F2"; // Helvetica, Helvetica-Bold

/** Approximate Helvetica advance widths (1/1000 em). Exact for digits and punctuation used in numbers. */
function textWidth(s: string, size: number): number {
  let w = 0;
  for (const ch of s) {
    if (ch >= "0" && ch <= "9") w += 556;
    else if (ch === "." || ch === "," || ch === " " || ch === "'" || ch === "i" || ch === "l" || ch === "|") w += 278;
    else if (ch === "-") w += 333;
    else if (ch === "$" || ch === "#") w += 556;
    else if (ch === "m" || ch === "w" || ch === "M" || ch === "W") w += 833;
    else if (ch >= "A" && ch <= "Z") w += 667;
    else w += 520;
  }
  return (w * size) / 1000;
}

function wrap(text: string, maxWidth: number, size: number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r/g, "").split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = word;
      // Hard-split a word that is wider than the column on its own.
      while (textWidth(w, size) > maxWidth && w.length > 1) {
        let cut = w.length - 1;
        while (cut > 1 && textWidth(w.slice(0, cut), size) > maxWidth) cut--;
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const next = line ? `${line} ${w}` : w;
      if (textWidth(next, size) <= maxWidth) line = next;
      else {
        out.push(line);
        line = w;
      }
    }
    out.push(line);
  }
  return out;
}

const esc = (s: string) =>
  s
    .replace(/[^\x20-\x7e\xa0-\xff]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");

class Doc {
  private pages: string[][] = [[]];
  y = PAGE_H - MARGIN;

  private get ops() {
    return this.pages[this.pages.length - 1]!;
  }

  text(x: number, s: string, size = 10, font: Font = "F1", align: "left" | "right" = "left") {
    const px = align === "right" ? x - textWidth(s, size) : x;
    this.ops.push(`BT /${font} ${size} Tf ${px.toFixed(2)} ${this.y.toFixed(2)} Td (${esc(s)}) Tj ET`);
  }

  rule(width = 0.5) {
    this.ops.push(`${width} w ${MARGIN} ${this.y.toFixed(2)} m ${PAGE_W - MARGIN} ${this.y.toFixed(2)} l S`);
  }

  down(n: number) {
    this.y -= n;
  }

  /** Start a new page when fewer than `needed` points remain. Returns true if it did. */
  ensure(needed: number): boolean {
    if (this.y - needed >= BOTTOM) return false;
    this.pages.push([]);
    this.y = PAGE_H - MARGIN;
    return true;
  }

  build(): Buffer {
    const objs: string[] = [];
    const add = (body: string) => objs.push(body) && objs.length; // returns the 1-based object number
    add("<< /Type /Catalog /Pages 2 0 R >>");
    add(""); // pages, filled below
    add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const pageNums: number[] = [];
    const total = this.pages.length;
    this.pages.forEach((ops, i) => {
      const footer = `BT /F1 8 Tf ${MARGIN} 30 Td (${esc(`Page ${i + 1} of ${total}`)}) Tj ET`;
      const stream = [...ops, footer].join("\n");
      const contentNo = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
      pageNums.push(
        add(
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNo} 0 R >>`,
        ),
      );
    });
    objs[1] = `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageNums.length} >>`;

    let out = "%PDF-1.4\n";
    const offsets: number[] = [];
    objs.forEach((body, i) => {
      offsets.push(Buffer.byteLength(out, "latin1"));
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, "latin1");
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, "latin1");
  }
}

const money = (currency: string, v: string) => {
  const [int = "0", frac = "00"] = v.split(".");
  const neg = int.startsWith("-");
  const grouped = (neg ? int.slice(1) : int).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sym = currency === "USD" ? "$" : `${currency} `;
  return `${neg ? "-" : ""}${sym}${grouped}.${frac}`;
};

const dateOnly = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null);

export interface QuotePdfInput {
  quote: Pick<Schemas["CustomerQuote"], "displayNumber" | "number" | "title" | "currencyCode" | "ownerName" | "job" | "poNumber" | "neededBy" | "shipTo" | "assignedRepName">;
  version: Schemas["CustomerQuoteVersion"];
  expiresAt: string | null;
  companyName: string | null;
}

/** Render one SENT version as a PDF. */
export function renderQuotePdf(input: QuotePdfInput): Buffer {
  const { quote, version } = input;
  const cur = quote.currencyCode;
  const d = new Doc();
  const label = quote.displayNumber ?? `Q-${quote.number}`;

  d.text(MARGIN, "DSG Distributors", 11, "F2");
  d.text(PAGE_W - MARGIN, "QUOTE", 20, "F2", "right");
  d.down(18);
  d.text(PAGE_W - MARGIN, `${label}  -  Version ${version.versionNo}`, 11, "F1", "right");
  d.down(26);

  const info: [string, string | null][] = [
    ["Quote", quote.title],
    ["Prepared for", [quote.ownerName, input.companyName].filter(Boolean).join(", ") || null],
    ["Job", quote.job?.name ?? null],
    ["PO number", quote.poNumber ?? quote.job?.poNumber ?? null],
    ["Needed by", quote.neededBy ?? null],
    ["Prepared by", quote.assignedRepName ?? null],
    ["Date sent", dateOnly(version.sentAt)],
    ["Valid until", dateOnly(input.expiresAt)],
  ];
  for (const [k, v] of info) {
    if (!v) continue;
    const lines = wrap(v, PAGE_W - MARGIN - 150, 10);
    d.ensure(14 * lines.length + 14);
    d.text(MARGIN, k, 10, "F2");
    for (const l of lines) {
      d.text(150, l, 10);
      d.down(14);
    }
  }
  d.down(10);

  // table
  const X_ITEM = MARGIN;
  const X_QTY = 360;
  const X_UNIT = 450;
  const X_TOTAL = PAGE_W - MARGIN;
  const header = () => {
    d.text(X_ITEM, "Item", 9, "F2");
    d.text(X_QTY, "Qty", 9, "F2", "right");
    d.text(X_UNIT, "Unit price", 9, "F2", "right");
    d.text(X_TOTAL, "Total", 9, "F2", "right");
    d.down(5);
    d.rule();
    d.down(13);
  };
  header();
  for (const l of version.lines) {
    const title = wrap(l.title, X_QTY - 40 - X_ITEM, 9);
    const note = l.lineNote ? wrap(`Note: ${l.lineNote}`, X_QTY - 40 - X_ITEM, 8) : [];
    const sku = l.sku ? 1 : 0;
    const need = 12 * (title.length + sku) + 10 * note.length + 8;
    if (d.ensure(need + 20)) header();
    d.text(X_QTY, String(l.qty), 9, "F1", "right");
    d.text(X_UNIT, money(cur, l.quotedPrice), 9, "F1", "right");
    d.text(X_TOTAL, money(cur, l.lineTotal), 9, "F1", "right");
    for (const t of title) {
      d.text(X_ITEM, t, 9);
      d.down(12);
    }
    if (l.sku) {
      d.text(X_ITEM, `SKU ${l.sku}`, 8);
      d.down(12);
    }
    for (const n of note) {
      d.text(X_ITEM, n, 8);
      d.down(10);
    }
    d.down(4);
  }
  d.rule();
  d.down(16);

  const totals: [string, string][] = [["Subtotal", money(cur, version.subtotal)]];
  if (version.freight && version.freight !== "0.00") totals.push(["Freight", money(cur, version.freight)]);
  if (version.taxEstimate) totals.push(["Estimated tax", money(cur, version.taxEstimate)]);
  d.ensure(totals.length * 14 + 40);
  for (const [k, v] of totals) {
    d.text(X_UNIT, k, 10, "F1", "right");
    d.text(X_TOTAL, v, 10, "F1", "right");
    d.down(14);
  }
  d.text(X_UNIT, "Total", 11, "F2", "right");
  d.text(X_TOTAL, money(cur, version.total), 11, "F2", "right");
  d.down(26);

  if (version.repNote) {
    const lines = wrap(version.repNote, PAGE_W - 2 * MARGIN, 9);
    d.ensure(30);
    d.text(MARGIN, "Notes", 10, "F2");
    d.down(14);
    for (const l of lines) {
      d.ensure(12);
      d.text(MARGIN, l, 9);
      d.down(12);
    }
  }
  return d.build();
}
