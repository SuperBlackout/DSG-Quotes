// Screen 3: My Quotes list.
import { useMemo, useState } from "preact/hooks";
import { api } from "../api/instance";
import type { CustomerQuoteSummary } from "../api/types";
import { CHIPS, chipCounts, filterQuotes, groupQuotes, listSubtitle, type ChipId, type GroupBy } from "../lib/filters";
import { formatMoney, formatRelative } from "../lib/format";
import { previousTotalText, quoteSubline, rowActions, unreadLabel, type RowAction } from "../lib/status";
import { orderHref } from "../router";
import { ErrorBanner, Loading, NavLink, StatusBadge, WIDE_900, errorMessage } from "../ui/common";
import { valueOf } from "../ui/events";
import { go, useAction, useAsync } from "../ui/hooks";
import { NewQuoteModal } from "./NewQuoteModal";

const PAGE = 100;
const MAX_PAGES = 20;

/** Loads every page: chip counts and search are computed over the full list. */
async function loadAll(): Promise<CustomerQuoteSummary[]> {
  const all: CustomerQuoteSummary[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await api().listQuotes({ limit: PAGE, cursor });
    all.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return all;
}

export function QuoteList() {
  const list = useAsync(loadAll, []);
  const [chip, setChip] = useState<ChipId>("all");
  const [term, setTerm] = useState("");
  const [groupBy, setGroupBy] = useState<GroupBy>("job");
  const [deleting, setDeleting] = useState<CustomerQuoteSummary | undefined>(undefined);
  const [checkoutUrls, setCheckoutUrls] = useState<Record<string, string>>({});
  const action = useAction();

  const all = list.data ?? [];
  const counts = useMemo(() => chipCounts(all), [all]);
  const visible = useMemo(() => filterQuotes(all, chip, term), [all, chip, term]);
  const groups = useMemo(() => groupQuotes(visible, groupBy), [visible, groupBy]);

  async function onAction(q: CustomerQuoteSummary, a: RowAction) {
    switch (a.id) {
      case "review":
      case "view":
        go({ name: "detail", id: q.id });
        return;
      case "view-order":
        navigation.navigate(orderHref(q.orderId));
        return;
      case "buy": {
        // The Navigation API cannot leave customer accounts, so the row swaps to a real link.
        const res = await action.run(`buy:${q.id}`, () => api().checkout(q.id));
        if (res) setCheckoutUrls((m) => ({ ...m, [q.id]: res.invoiceUrl }));
        else list.reload(); // the quote may have expired or changed: show its current state
        return;
      }
      case "submit": {
        const res = await action.run(`submit:${q.id}`, () => api().submitQuote(q.id));
        if (res) list.reload();
        return;
      }
      case "duplicate": {
        const res = await action.run(`duplicate:${q.id}`, () => api().duplicateQuote(q.id));
        if (res) go({ name: "detail", id: res.id });
        return;
      }
      case "delete":
        // Opened by the button's commandFor; here we only remember which draft it is.
        setDeleting(q);
        return;
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    const res = await action.run(`delete:${deleting.id}`, () => api().deleteQuote(deleting.id));
    setDeleting(undefined);
    if (res !== undefined) list.reload();
  }

  return (
    <s-page heading="My Quotes" subheading={list.data ? listSubtitle(all) : undefined}>
      <s-button slot="primary-action" variant="primary" commandFor="new-quote-modal" command="--show">
        + New quote
      </s-button>
      <s-button slot="secondary-actions" onClick={() => go({ name: "notifications" })}>
        Notification settings
      </s-button>

      <s-query-container>
        <s-stack direction="block" gap="base">
          {list.error ? <ErrorBanner error={list.error} onRetry={list.reload} /> : null}
          {action.error ? (
            <s-banner tone="critical" heading="That did not work" dismissible onDismiss={action.clearError}>
              {errorMessage(action.error)}
            </s-banner>
          ) : null}

          <s-scroll-box>
            <s-stack direction="inline" gap="small">
              {CHIPS.map((c) => (
                <s-press-button key={c.id} pressed={chip === c.id} onClick={() => setChip(c.id)}>
                  {c.label} · {counts[c.id]}
                </s-press-button>
              ))}
            </s-stack>
          </s-scroll-box>

          <s-grid gridTemplateColumns={`${WIDE_900} 2fr 1fr, 1fr`} gap="base" alignItems="end">
            <s-text-field
              label="Search quotes"
              labelAccessibilityVisibility="exclusive"
              icon="search"
              placeholder="Search job, PO or quote #"
              value={term}
              onInput={(e: Event) => setTerm(valueOf(e))}
            />
            <s-select
              label="Group by"
              value={groupBy}
              onChange={(e: Event) => setGroupBy(valueOf(e) as GroupBy)}
            >
              <s-option value="job">Group by: Job</s-option>
              <s-option value="status">Group by: Status</s-option>
              <s-option value="none">Group by: None</s-option>
            </s-select>
          </s-grid>

          {list.loading && !list.data ? <Loading label="Loading your quotes" /> : null}

          {list.data && visible.length === 0 ? (
            <s-banner tone="info" heading={all.length === 0 ? "No quotes yet" : "No quotes match"}>
              {all.length === 0
                ? "Add products to a quote from the shop, or start one here."
                : "Try a different filter or search term."}
            </s-banner>
          ) : null}

          {groups.map((g) => (
            <s-section key={g.key} heading={g.title || undefined}>
              <s-stack direction="block" gap="base">
                {groupBy !== "none" ? (
                  <s-stack direction="inline" gap="base" justifyContent="space-between">
                    <s-text color="subdued">
                      {groupBy === "job" && g.job
                        ? [g.job.poNumber ? `PO ${g.job.poNumber}` : "No PO yet", g.job.siteAddress ? `Ship to: ${g.job.siteAddress}` : ""]
                            .filter(Boolean)
                            .join(" · ")
                        : ""}
                    </s-text>
                    <s-text color="subdued">{g.summary}</s-text>
                  </s-stack>
                ) : null}
                <s-divider />
                {g.quotes.map((q, i) => (
                  <s-stack key={q.id} direction="block" gap="base">
                    {i > 0 ? <s-divider /> : null}
                    <QuoteRow
                      quote={q}
                      busy={action.busy}
                      checkoutUrl={checkoutUrls[q.id]}
                      onAction={(a) => void onAction(q, a)}
                    />
                  </s-stack>
                ))}
              </s-stack>
            </s-section>
          ))}
        </s-stack>
      </s-query-container>

      <NewQuoteModal jobs={uniqueJobs(all)} />

      <s-modal id="delete-modal" heading="Delete this draft?">
        <s-text>
          {deleting ? `${deleting.displayNumber ?? `Q-${deleting.number}`} · ${deleting.title}` : "This draft"} will be removed
          from your list. This cannot be undone.
        </s-text>
        <s-button slot="secondary-actions" commandFor="delete-modal" command="--hide">
          Keep draft
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          commandFor="delete-modal"
          command="--hide"
          loading={action.busy?.startsWith("delete:")}
          onClick={() => void confirmDelete()}
        >
          Delete draft
        </s-button>
      </s-modal>
    </s-page>
  );
}

function uniqueJobs(quotes: CustomerQuoteSummary[]) {
  const seen = new Map<string, { id: string; name: string }>();
  for (const q of quotes) if (q.job && !seen.has(q.job.id)) seen.set(q.job.id, { id: q.job.id, name: q.job.name });
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function QuoteRow({
  quote: q,
  busy,
  checkoutUrl,
  onAction,
}: {
  quote: CustomerQuoteSummary;
  busy: string | undefined;
  checkoutUrl: string | undefined;
  onAction: (a: RowAction) => void;
}) {
  const actions = rowActions(q);
  const closed = q.waitingOn === "none";
  const was = previousTotalText(q);
  const unread = unreadLabel(q);
  return (
    <s-grid
      gridTemplateColumns={`${WIDE_900} 6rem minmax(0, 2fr) 14rem 8rem 8rem auto, 1fr`}
      gap="small"
      alignItems="center"
    >
      <NavLink route={{ name: "detail", id: q.id }}>{q.displayNumber ?? `Q-${q.number}`}</NavLink>
      <s-stack direction="block" gap="small-300">
        <s-text type="strong" color={closed ? "subdued" : "base"}>
          {q.title}
        </s-text>
        <s-text color="subdued" type="small">
          {quoteSubline(q)}
        </s-text>
      </s-stack>
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <StatusBadge quote={q} />
        {unread ? <s-badge tone="critical">{unread}</s-badge> : null}
      </s-stack>
      <s-stack direction="block" gap="small-300">
        <s-text type="strong">{formatMoney(q.total, q.currencyCode)}</s-text>
        {was ? <s-text type="redundant" color="subdued">{was}</s-text> : null}
      </s-stack>
      <s-text color="subdued">{formatRelative(q.updatedAt)}</s-text>
      <s-stack direction="inline" gap="small">
        {actions.map((a) =>
          a.id === "buy" && checkoutUrl ? (
            <s-button key={a.id} variant="primary" href={checkoutUrl}>
              Continue to checkout
            </s-button>
          ) : (
            <s-button
              key={a.id}
              variant={a.variant}
              tone={a.tone}
              loading={busy === `${a.id === "view-order" ? "view" : a.id}:${q.id}`}
              accessibilityLabel={`${a.label} ${q.displayNumber ?? `Q-${q.number}`}`}
              // Delete only opens the confirm dialog; the dialog's button does the work.
              {...(a.id === "delete" ? { commandFor: "delete-modal", command: "--show" as const } : {})}
              onClick={() => onAction(a)}
            >
              {a.label}
            </s-button>
          ),
        )}
      </s-stack>
    </s-grid>
  );
}
