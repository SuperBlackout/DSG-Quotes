import type { EditorLine, LineChange } from "../lib/editor-state";
import { formatPct } from "../lib/editor-state";
import {
  formatMoney,
  isBelowFloor,
  lineTotalCents,
  marginPct,
  minPriceForFloor,
  parseMoney,
  parseQty,
  toMoneyString,
} from "../lib/pricing";
import { CommitField } from "./CommitField";

export function LinesTable({
  lines,
  floorPct,
  changes,
  versionLabel,
  disabled,
  onQty,
  onPrice,
  onNote,
  onRemove,
}: {
  lines: EditorLine[];
  floorPct: number;
  changes: Map<string, LineChange>;
  versionLabel: string;
  disabled?: boolean;
  onQty: (key: string, text: string) => void;
  onPrice: (key: string, cents: number) => void;
  onNote: (key: string, text: string) => void;
  onRemove: (key: string) => void;
}) {
  if (lines.length === 0) {
    return (
      <s-box padding="large">
        <s-text color="subdued">No line items yet. Use Add product to start pricing.</s-text>
      </s-box>
    );
  }
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">Item</s-table-header>
        <s-table-header format="numeric">Qty</s-table-header>
        <s-table-header format="currency">Cost</s-table-header>
        <s-table-header format="currency">Dealer</s-table-header>
        <s-table-header format="currency">Quote price</s-table-header>
        <s-table-header format="numeric">Margin</s-table-header>
        <s-table-header format="currency">Total</s-table-header>
        <s-table-header>Remove</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {lines.map((l) => {
          const below = !l.floorApproved && isBelowFloor(l.quotedPriceCents, l.costCents, floorPct);
          const m = marginPct(l.quotedPriceCents, l.costCents);
          const change = changes.get(l.key);
          const minPrice = below ? minPriceForFloor(l.costCents, floorPct) : null;
          return (
            <s-table-row key={l.key}>
              <s-table-cell>
                <s-stack gap="small-500">
                  <s-stack direction="inline" gap="small-300" alignItems="center">
                    <s-text type="strong">{l.title}</s-text>
                    {change?.kind === "new" ? <s-badge tone="info">New in {versionLabel}</s-badge> : null}
                  </s-stack>
                  <s-text color="subdued">
                    {l.sku ?? "No SKU"}
                    {change?.kind === "qty" ? ` · qty ${change.from} → ${l.qty}` : ""}
                    {change?.kind === "price" ? ` · price ${formatMoney(change.from)} → ${formatMoney(l.quotedPriceCents)}` : ""}
                  </s-text>
                  {below ? (
                    <s-text tone="critical" type="strong">
                      Below {floorPct}% floor, needs manager approval
                      {minPrice !== null ? ` (minimum ${formatMoney(minPrice)})` : ""}
                    </s-text>
                  ) : null}
                  {l.floorApproved && isBelowFloor(l.quotedPriceCents, l.costCents, floorPct) ? (
                    <s-badge tone="success">Floor approved</s-badge>
                  ) : null}
                  <s-text-field
                    label={`Line note for ${l.sku ?? l.title}`}
                    labelAccessibilityVisibility="exclusive"
                    placeholder="Line note (visible to customer)"
                    value={l.lineNote}
                    disabled={disabled}
                    onInput={(e) => onNote(l.key, e.currentTarget.value)}
                  />
                </s-stack>
              </s-table-cell>
              <s-table-cell>
                <CommitField
                  label={`Quantity ${l.sku ?? l.title}`}
                  value={String(l.qty)}
                  disabled={disabled}
                  isValid={(t) => parseQty(t) !== null}
                  onValid={(t) => onQty(l.key, t)}
                />
              </s-table-cell>
              <s-table-cell>{l.costCents === null ? <s-text color="subdued">on save</s-text> : formatMoney(l.costCents)}</s-table-cell>
              <s-table-cell>{formatMoney(l.listPriceCents)}</s-table-cell>
              <s-table-cell>
                <CommitField
                  label={`Quote price ${l.sku ?? l.title}`}
                  value={toMoneyString(l.quotedPriceCents)}
                  disabled={disabled}
                  isValid={(t) => {
                    const c = parseMoney(t);
                    return c !== null && c >= 0;
                  }}
                  onValid={(t) => onPrice(l.key, parseMoney(t) ?? 0)}
                />
              </s-table-cell>
              <s-table-cell>{below ? <s-badge tone="critical">{formatPct(m)}</s-badge> : formatPct(m)}</s-table-cell>
              <s-table-cell>
                <s-text type="strong">{formatMoney(lineTotalCents(l))}</s-text>
              </s-table-cell>
              <s-table-cell>
                <s-button
                  variant="tertiary"
                  tone="critical"
                  icon="delete"
                  accessibilityLabel={`Remove ${l.sku ?? l.title}`}
                  disabled={disabled}
                  onClick={() => onRemove(l.key)}
                />
              </s-table-cell>
            </s-table-row>
          );
        })}
      </s-table-body>
    </s-table>
  );
}
