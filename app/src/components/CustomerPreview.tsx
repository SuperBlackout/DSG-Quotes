import type { EditorState } from "../lib/editor-state";
import { dateInputToIso } from "../lib/editor-state";
import { computeTotals, formatMoney, lineTotalCents } from "../lib/pricing";

/**
 * "Preview as customer": renders only what the customer will see in the sent version (CustomerQuoteLine /
 * CustomerQuoteVersion fields). Cost, margin, floor flags and the internal note are never referenced here.
 */
export function CustomerPreview({
  id,
  versionNo,
  number,
  title,
  state,
}: {
  id: string;
  versionNo: number;
  number: string;
  title: string;
  state: EditorState;
}) {
  const totals = computeTotals(state.lines, state.freightCents);
  const goodUntil = dateInputToIso(state.expiresOn) ? state.expiresOn : null;
  return (
    <s-modal id={id} heading={`${number} · v${versionNo} as your customer sees it`} size="large">
      <s-stack gap="base">
        <s-heading>{title}</s-heading>
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Item</s-table-header>
            <s-table-header format="numeric">Qty</s-table-header>
            <s-table-header format="currency">Price</s-table-header>
            <s-table-header format="currency">Total</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {state.lines.map((l) => (
              <s-table-row key={l.key}>
                <s-table-cell>
                  <s-stack gap="small-500">
                    <s-text type="strong">{l.title}</s-text>
                    {l.sku ? <s-text color="subdued">{l.sku}</s-text> : null}
                    {l.lineNote.trim() ? <s-text color="subdued">{l.lineNote}</s-text> : null}
                  </s-stack>
                </s-table-cell>
                <s-table-cell>{l.qty}</s-table-cell>
                <s-table-cell>{formatMoney(l.quotedPriceCents)}</s-table-cell>
                <s-table-cell>{formatMoney(lineTotalCents(l))}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        <s-stack gap="small-300">
          <s-stack direction="inline" justifyContent="space-between">
            <s-text>Subtotal</s-text>
            <s-text>{formatMoney(totals.subtotalCents)}</s-text>
          </s-stack>
          <s-stack direction="inline" justifyContent="space-between">
            <s-text>Freight</s-text>
            <s-text>{formatMoney(totals.freightCents)}</s-text>
          </s-stack>
          <s-stack direction="inline" justifyContent="space-between">
            <s-text type="strong">Total</s-text>
            <s-text type="strong">{formatMoney(totals.totalCents)}</s-text>
          </s-stack>
        </s-stack>
        {state.repNote.trim() ? (
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack gap="small-300">
              <s-text type="strong">Notes from your rep</s-text>
              <s-paragraph>{state.repNote}</s-paragraph>
            </s-stack>
          </s-box>
        ) : null}
        {goodUntil ? <s-text color="subdued">Prices good until {goodUntil}</s-text> : null}
      </s-stack>
      <s-button slot="secondary-actions" commandFor={id} command="--hide">
        Close
      </s-button>
    </s-modal>
  );
}
