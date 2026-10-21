import type { EditorLine, LineChange } from "../lib/editor-state";
import { formatPct, snapshotState } from "../lib/editor-state";
import {
  approvalReason,
  formatMoneyIn,
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
  currencyCode,
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
  currencyCode?: string;
  changes: Map<string, LineChange>;
  versionLabel: string;
  disabled?: boolean;
  onQty: (key: string, text: string) => void;
  onPrice: (key: string, cents: number) => void;
  onNote: (key: string, text: string) => void;
  onRemove: (key: string) => void;
}) {
  const money = (cents: number) => formatMoneyIn(cents, currencyCode);
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
          const reason = approvalReason(l, floorPct);
          const unknownCost = !!l.costUnknown;
          const pending = snapshotState(l) === "pending";
          const below = reason === "below_floor";
          const m = unknownCost ? null : marginPct(l.quotedPriceCents, l.costCents);
          const change = changes.get(l.key);
          const minPrice = below ? minPriceForFloor(l.costCents, floorPct) : null;
          return (
            <s-table-row key={l.key}>
              <s-table-cell>
                <s-stack gap="small-500">
                  <s-stack direction="inline" gap="small-300" alignItems="center">
                    <s-text type="strong">{l.title}</s-text>
                    {change?.kind === "new" ? <s-badge tone="info">New in {versionLabel}</s-badge> : null}
                    {unknownCost ? <s-badge tone="critical">Unknown cost</s-badge> : null}
                  </s-stack>
                  <s-text color="subdued">
                    {l.sku ?? "No SKU"}
                    {change?.kind === "qty" ? ` · qty ${change.from} → ${l.qty}` : ""}
                    {change?.kind === "price" ? ` · price ${money(change.from)} → ${money(l.quotedPriceCents)}` : ""}
                  </s-text>
                  {reason === "unknown_cost" ? (
                    <s-text tone="critical" type="strong">
                      Cost not found in inventory, needs manager approval
                    </s-text>
                  ) : null}
                  {below ? (
                    <s-text tone="critical" type="strong">
                      Below {floorPct}% floor, needs manager approval
                      {minPrice !== null ? ` (minimum ${money(minPrice)})` : ""}
                    </s-text>
                  ) : null}
                  {l.floorApproved && (unknownCost || isBelowFloor(l.quotedPriceCents, l.costCents, floorPct)) ? (
                    <s-badge tone="success">Floor approved</s-badge>
                  ) : null}
                  <s-text-field
                    label={`Line note for ${l.sku ?? l.title} (visible to customer)`}
                    labelAccessibilityVisibility="exclusive"
                    placeholder="Visible to customer"
                    details="Visible to customer"
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
              <s-table-cell>
                {unknownCost ? (
                  <s-text color="subdued">Unknown</s-text>
                ) : pending || l.costCents === null ? (
                  <s-text color="subdued">Saving…</s-text>
                ) : (
                  money(l.costCents)
                )}
              </s-table-cell>
              <s-table-cell>{money(l.listPriceCents)}</s-table-cell>
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
              <s-table-cell>
                {unknownCost || m === null ? (
                  <s-text color="subdued">{"—"}</s-text>
                ) : below ? (
                  <s-badge tone="critical">{formatPct(m)}</s-badge>
                ) : (
                  formatPct(m)
                )}
              </s-table-cell>
              <s-table-cell>
                <s-text type="strong">{money(lineTotalCents(l))}</s-text>
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
