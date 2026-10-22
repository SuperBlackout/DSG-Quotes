import { useEffect, useMemo, useReducer } from 'preact/hooks';
import { createApi, shopifyToken } from '@dsg/account-client';
import { createStatementStore } from './state.ts';
import { displayNumber, formatAsOf, formatDate, formatMoney, statusLabel, statusTone } from '@dsg/account-client';

const TYPE_OPTIONS = [
  ['', 'All types'],
  ['invoice', 'Invoices'],
  ['payment', 'Payments'],
  ['credit_note', 'Credit notes'],
  ['sales_order', 'Sales orders'],
];

function useStore() {
  const store = useMemo(() => createStatementStore(createApi({ getToken: shopifyToken })), []);
  const [, bump] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    const unsub = store.subscribe(bump);
    store.load();
    return unsub;
  }, [store]);
  return [store, store.getState()];
}

// Customer account extensions have no table component, so activity is a compact grid of rows.
// Fixed widths keep every row aligned; the Number column takes what is left. minmax(0, …) stops long text widening it.
const COLS = '92px 112px minmax(0, 1fr) 78px 78px 78px';

// Invoice number doubles as the PDF control. Step 1 (click) mints a single-use link, step 2 opens it in a new tab.
function InvoiceNumber({ it, st, store }) {
  const shown = displayNumber(it.kind, it.number);
  if (!(it.hasPdf && it.kind === 'invoice')) return <s-text>{shown}</s-text>;
  if (st.pdfBusyId === it.id) return <s-text color="subdued">Preparing…</s-text>;
  if (st.pdfLink && st.pdfLink.forId === it.id) {
    return <s-link href={st.pdfLink.url} target="_blank">Open {it.number} ↗</s-link>;
  }
  return <s-link onClick={() => store.downloadInvoice(it.id)} accessibilityLabel={`Open PDF for ${it.number}`}>{it.number}</s-link>;
}

function SummaryCard({ label, value, tone }) {
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack gap="small-300">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        {tone ? <s-badge tone={tone}>{tone === 'critical' ? 'Past due' : ''}</s-badge> : null}
      </s-stack>
    </s-box>
  );
}

export function StatementPage() {
  const [store, st] = useStore();

  if (st.status === 'loading') {
    return (
      <s-page heading="Account statement">
        <s-stack alignItems="center" padding="large"><s-spinner accessibilityLabel="Loading statement" /></s-stack>
      </s-page>
    );
  }

  if (st.status === 'error') {
    const k = st.error.kind;
    const heading = k === 'not_linked' ? 'Account not linked' : k === 'unavailable' ? 'Temporarily unavailable' : k === 'rate_limited' ? 'Too many requests' : k === 'bad_request' ? 'Invalid request' : 'Could not load statement';
    return (
      <s-page heading="Account statement">
        <s-banner tone={k === 'not_linked' ? 'warning' : 'critical'} heading={heading}>
          <s-text>{st.error.message}</s-text>
          {k === 'not_linked' ? <s-text> Contact your account manager to link your company to billing.</s-text> : null}
        </s-banner>
        {k !== 'not_linked' ? <s-button onClick={() => store.load()}>Try again</s-button> : null}
      </s-page>
    );
  }

  const { summary: s, items, nextCursor, filters } = st;
  const cur = s.currency;

  return (
    <s-page heading="Account statement">
      <s-button slot="primary-action" onClick={() => store.downloadStatement()}>Download statement PDF</s-button>

      <s-stack gap="base">
        <s-stack gap="small-300">
          <s-heading>{s.customerName}</s-heading>
          <s-text color="subdued">Customer no. {s.customerNumber} · As of {formatAsOf(s.asOf)}</s-text>
        </s-stack>

        {s.stale ? (
          <s-banner tone="warning" heading="This data may be out of date">
            <s-text>We could not refresh your account recently. Balances shown are as of {formatAsOf(s.asOf)}.</s-text>
          </s-banner>
        ) : null}
        {st.pdfLink && !st.pdfLink.forId ? (
          <s-banner tone="success" heading={`${st.pdfLink.label} ready`} dismissible onDismiss={() => store.clearPdf()}>
            <s-stack gap="small-300">
              <s-link href={st.pdfLink.url} target="_blank">Open PDF</s-link>
              <s-text color="subdued">The link works once and expires in a few minutes. Request a new one if it stops working.</s-text>
            </s-stack>
          </s-banner>
        ) : null}
        {st.pdfError ? <s-banner tone="critical" heading="PDF unavailable"><s-text>{st.pdfError}</s-text></s-banner> : null}

        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
          <SummaryCard label="Outstanding" value={formatMoney(s.outstanding, cur)} />
          <SummaryCard label="Overdue" value={formatMoney(s.overdue, cur)} tone={s.overdue !== '0.00' ? 'critical' : undefined} />
          <SummaryCard label="Unused credits" value={formatMoney(s.unusedCredits, cur)} />
          <SummaryCard label="Credit limit" value={s.creditLimit && s.creditLimit !== '0.00' ? formatMoney(s.creditLimit, cur) : 'Not set'} />
          <SummaryCard label="Payment terms" value={s.paymentTerms ?? '—'} />
        </s-grid>

        <s-section heading="Activity">
          <s-stack gap="base">
            <s-text-field label="Search PO, reference or number" value={filters.search} placeholder="e.g. QU-031920" onChange={(e) => store.setFilters({ search: e.currentTarget.value })} />
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
              <s-select label="Type" value={filters.type} onChange={(e) => store.setFilters({ type: e.currentTarget.value })}>
                {TYPE_OPTIONS.map(([v, l]) => <s-option key={v} value={v}>{l}</s-option>)}
              </s-select>
              <s-date-field label="From" value={filters.from} onChange={(e) => store.setFilters({ from: e.currentTarget.value })} />
              <s-date-field label="To" value={filters.to} onChange={(e) => store.setFilters({ to: e.currentTarget.value })} />
            </s-grid>

            {st.moreError ? <s-banner tone="critical" heading="Could not load activity"><s-text>{st.moreError}</s-text></s-banner> : null}

            {items.length === 0 && !st.loadingMore ? (
              <s-text color="subdued">No activity found for the selected filters.</s-text>
            ) : (
              <s-scroll-box direction="inline">
                <s-box minInlineSize="600px">
                  <s-stack gap="small-200">
                    <s-grid gridTemplateColumns={COLS} gap="small-300">
                      <s-text color="subdued">Date</s-text>
                      <s-text color="subdued">Number</s-text>
                      <s-text color="subdued">Reference / PO</s-text>
                      <s-text color="subdued">Status</s-text>
                      <s-stack alignItems="end"><s-text color="subdued">Total</s-text></s-stack>
                      <s-stack alignItems="end"><s-text color="subdued">Balance</s-text></s-stack>
                    </s-grid>
                    <s-divider />
                    {items.map((it) => (
                      <s-grid key={`${it.kind}-${it.id}`} gridTemplateColumns={COLS} gap="small-300" alignItems="center">
                        <s-text>{formatDate(it.date)}</s-text>
                        <InvoiceNumber it={it} st={st} store={store} />
                        <s-text color="subdued">{it.reference ?? '—'}</s-text>
                        <s-stack alignItems="start"><s-badge tone={statusTone(it.status)}>{statusLabel(it.status)}</s-badge></s-stack>
                        <s-stack alignItems="end"><s-text>{formatMoney(it.total, cur)}</s-text></s-stack>
                        <s-stack alignItems="end"><s-text>{formatMoney(it.balance, cur)}</s-text></s-stack>
                      </s-grid>
                    ))}
                  </s-stack>
                </s-box>
              </s-scroll-box>
            )}

            {st.loadingMore ? <s-spinner accessibilityLabel="Loading activity" /> : null}
            {nextCursor && !st.loadingMore ? <s-button onClick={() => store.loadMore()}>Load more</s-button> : null}
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}
