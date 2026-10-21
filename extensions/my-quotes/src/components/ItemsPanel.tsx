// "Items" card: version tabs, highlight-changes toggle, line table, rep notes and totals.
// Only fields from Schemas["CustomerQuoteLine" | "CustomerQuoteVersion"] are shown (never cost or margin).
import type { CustomerQuote, CustomerQuoteLine } from "../api/types";
import { buildDetailView, versionTabs, type DetailView } from "../lib/detail";
import type { LineChange } from "../lib/diff";
import { savingsCents } from "../lib/diff";
import { formatCents, formatMoney, toCents } from "../lib/format";
import { WIDE_700 } from "../ui/common";
import { checkedOf } from "../ui/events";

// Columns: item | qty | list ("your price") | quoted | line total
const COLS = `${WIDE_700} minmax(0, 3fr) 4rem 6rem 6rem 6rem, 1fr`;

export function ItemsPanel({
  quote,
  selected,
  onSelect,
  highlight,
  onHighlight,
}: {
  quote: CustomerQuote;
  selected: number | undefined;
  onSelect: (versionNo: number) => void;
  highlight: boolean;
  onHighlight: (on: boolean) => void;
}) {
  const view = buildDetailView(quote, selected);
  const tabs = versionTabs(quote);
  const canCompare = view.comparedTo !== undefined && view.diff.hasChanges;
  const showDiff = highlight && canCompare;
  const changeByLine = new Map(view.diff.lines.map((c) => [c.line.id, c]));

  return (
    <s-section heading="Items">
      <s-stack direction="block" gap="base">
        {tabs.length > 0 ? (
          <s-grid gridTemplateColumns={`${WIDE_700} auto 1fr, 1fr`} gap="base" alignItems="center">
            <s-stack direction="inline" gap="small-200" accessibilityLabel="Quote version">
              {tabs.map((t) => (
                <s-press-button
                  key={t.versionNo}
                  pressed={view.versionNo === t.versionNo}
                  accessibilityLabel={`Show version ${t.versionNo}`}
                  onClick={() => onSelect(t.versionNo)}
                >
                  {t.label}
                </s-press-button>
              ))}
            </s-stack>
            {view.comparedTo !== undefined ? (
              <s-checkbox
                label={`Highlight changes from v${view.comparedTo}`}
                checked={highlight}
                onChange={(e: Event) => onHighlight(checkedOf(e))}
              />
            ) : null}
          </s-grid>
        ) : null}

        {!view.isCurrent && view.versionNo !== undefined ? (
          <s-banner tone="info">You are looking at an earlier version. The current one is v{quote.currentVersion}.</s-banner>
        ) : null}

        {/* Header row: hidden on narrow screens where each line shows its own labelled summary. */}
        <s-grid gridTemplateColumns={COLS} gap="small" display={`${WIDE_700} auto, none`}>
          <s-text color="subdued" type="strong">Item</s-text>
          <s-text color="subdued" type="strong">Qty</s-text>
          <s-text color="subdued" type="strong">Your price</s-text>
          <s-text color="subdued" type="strong">Quoted</s-text>
          <s-text color="subdued" type="strong">Total</s-text>
        </s-grid>
        <s-divider />

        {view.lines.length === 0 ? <s-text color="subdued">No items on this quote yet.</s-text> : null}
        {view.lines.map((line) => (
          <LineRow key={line.id} line={line} change={showDiff ? changeByLine.get(line.id) : undefined} />
        ))}

        {showDiff && view.diff.removed.length > 0 ? (
          <s-box background="subdued" padding="base" borderRadius="base">
            <s-stack direction="block" gap="small-300">
              <s-text type="strong">Removed since v{view.comparedTo}</s-text>
              {view.diff.removed.map((l) => (
                <s-text key={l.id} type="redundant">
                  {l.title}{l.sku ? ` (${l.sku})` : ""} · qty {l.qty}
                </s-text>
              ))}
            </s-stack>
          </s-box>
        ) : null}

        <s-divider />
        <s-grid gridTemplateColumns={`${WIDE_700} 1fr 20rem, 1fr`} gap="base" alignItems="start">
          <RepNotes quote={quote} view={view} />
          <Totals view={view} showDiff={showDiff} />
        </s-grid>
      </s-stack>
    </s-section>
  );
}

function LineRow({ line, change }: { line: CustomerQuoteLine; change: LineChange | undefined }) {
  const added = change?.kind === "added";
  const changed = change?.kind === "changed";
  const discounted = toCents(line.quotedPrice) < toCents(line.listPrice);
  const qtyText = change?.qtyFrom !== undefined ? `${line.qty}` : String(line.qty);

  const body = (
    <s-stack direction="block" gap="small-100">
      <s-grid gridTemplateColumns={COLS} gap="small" alignItems="center">
        <s-stack direction="block" gap="small-300">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text type="strong">{line.title}</s-text>
            {added ? <s-badge tone="auto">Added by rep</s-badge> : null}
          </s-stack>
          <s-text color="subdued" type="small">
            {[
              line.sku,
              change?.qtyFrom !== undefined ? `qty ${change.qtyFrom} → ${line.qty}` : undefined,
              change?.quotedPriceFrom !== undefined ? `was ${formatMoney(change.quotedPriceFrom)}` : undefined,
              line.lineNote ? `"${line.lineNote}"` : undefined,
            ]
              .filter(Boolean)
              .join(" · ")}
          </s-text>
        </s-stack>

        {/* Wide layout cells */}
        <s-text type="strong" tone={change?.qtyFrom !== undefined ? "warning" : "auto"} display={`${WIDE_700} auto, none`}>
          {qtyText}
        </s-text>
        <s-text display={`${WIDE_700} auto, none`} type={discounted ? "redundant" : undefined}>
          {formatMoney(line.listPrice)}
        </s-text>
        <s-text
          display={`${WIDE_700} auto, none`}
          type={discounted ? "strong" : undefined}
          tone={discounted ? "success" : "auto"}
        >
          {formatMoney(line.quotedPrice)}
        </s-text>
        <s-text type="strong" display={`${WIDE_700} auto, none`}>
          {formatMoney(line.lineTotal)}
        </s-text>
      </s-grid>

      {/* Narrow layout: one labelled line instead of the columns */}
      <s-stack direction="inline" gap="small-200" display={`${WIDE_700} none, auto`}>
        <s-text tone={change?.qtyFrom !== undefined ? "warning" : "auto"}>Qty {qtyText}</s-text>
        <s-text color="subdued">·</s-text>
        {discounted ? <s-text type="redundant">{formatMoney(line.listPrice)}</s-text> : null}
        <s-text tone={discounted ? "success" : "auto"} type={discounted ? "strong" : undefined}>
          {formatMoney(line.quotedPrice)}
        </s-text>
        <s-text color="subdued">·</s-text>
        <s-text type="strong">{formatMoney(line.lineTotal)}</s-text>
      </s-stack>
    </s-stack>
  );

  return added || changed ? (
    <s-box background="subdued" padding="small" borderRadius="base">
      {body}
    </s-box>
  ) : (
    <s-box padding="small">{body}</s-box>
  );
}

function RepNotes({ quote, view }: { quote: CustomerQuote; view: DetailView }) {
  if (!view.repNote) return <s-box />;
  return (
    <s-box background="subdued" padding="base" borderRadius="base">
      <s-stack direction="block" gap="small-300">
        <s-text color="subdued" type="small">
          Notes from DSG{quote.assignedRepName ? ` · ${quote.assignedRepName}` : ""}
        </s-text>
        <s-text>{view.repNote}</s-text>
      </s-stack>
    </s-box>
  );
}

function Totals({ view, showDiff }: { view: DetailView; showDiff: boolean }) {
  const saved = savingsCents(view.lines);
  const hasDiscount = view.discountTotal !== undefined && toCents(view.discountTotal) !== 0;
  const hasFreight = view.freight !== undefined;
  return (
    <s-stack direction="block" gap="small-200">
      <TotalRow label="Subtotal" value={formatMoney(view.subtotal)} />
      {hasDiscount ? <TotalRow label="Discount" value={`−${formatMoney(view.discountTotal)}`} /> : null}
      {hasFreight ? <TotalRow label="Freight" value={formatMoney(view.freight)} /> : null}
      {view.taxEstimate ? <TotalRow label="Estimated tax" value={formatMoney(view.taxEstimate)} /> : null}
      <s-divider />
      <TotalRow label="Total" value={formatMoney(view.total)} strong />
      {showDiff && view.diff.totalFrom ? (
        <s-text color="subdued" type="small">
          Was {formatMoney(view.diff.totalFrom)} in v{view.comparedTo}
        </s-text>
      ) : null}
      {saved > 0 ? <s-text tone="success">You save {formatCents(saved)} vs your dealer price</s-text> : null}
    </s-stack>
  );
}

function TotalRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <s-stack direction="inline" justifyContent="space-between" gap="base">
      <s-text color={strong ? "base" : "subdued"} type={strong ? "strong" : undefined}>
        {label}
      </s-text>
      <s-text type={strong ? "strong" : undefined}>{value}</s-text>
    </s-stack>
  );
}
