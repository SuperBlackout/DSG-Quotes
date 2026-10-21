/**
 * Deep scan applied to EVERY /c response (success and error) by the harness (CLAUDE.md rules 4 and 5):
 *  - no key that only exists on staff shapes, at any depth;
 *  - none of the planted internal-note / secret strings anywhere in the raw body;
 *  - none of the planted unit-cost values as a standalone number or string;
 *  - none of the margin figures the staff API reports for the fixture lines.
 */
import { COSTS, MARGIN_FIGURES, SECRETS } from "./fixtures";

export const FORBIDDEN_KEYS = new Set([
  "cost", "unitCost", "unit_cost", "costPrice",
  "margin", "marginPct", "marginTotal", "marginPercent", "margin_pct",
  "internalNote", "internal_note", "workingInternalNote", "workingRepNote", "workingFreight", "workingLines", "workingExpiresAt",
  "internal",
  "belowFloor", "floorApproved", "floorApprovedById", "priceFloorPct", "floorPct",
  "latestChangeRequest", "createdByStaffId", "assignedRepId", "teamId", "sentById", "authorId",
  "customerEmail", "draftOrderInvoiceUrl",
]);

function walk(value: unknown, visit: (key: string, path: string) => void, path = "$") {
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, visit, `${path}[${i}]`));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      visit(k, `${path}.${k}`);
      walk(v, visit, `${path}.${k}`);
    }
  }
}

const numberToken = (n: string) => new RegExp(`(?<![\\d.])${n.replace(".", "\\.")}(?!\\d)`);

/** Returns every leak found in one response; empty array means clean. */
export function findLeaks(text: string, body: unknown): string[] {
  const leaks: string[] = [];
  walk(body, (k, path) => {
    if (FORBIDDEN_KEYS.has(k)) leaks.push(`forbidden key "${k}" at ${path}`);
  });
  for (const s of SECRETS) if (text.includes(s)) leaks.push(`internal text leaked: ${s}`);
  for (const c of COSTS) if (numberToken(c).test(text)) leaks.push(`unit cost ${c} appears in the response`);
  for (const m of MARGIN_FIGURES) if (numberToken(m).test(text)) leaks.push(`margin figure ${m} appears in the response`);
  return leaks;
}
