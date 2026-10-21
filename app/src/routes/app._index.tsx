/**
 * Screen 6: sales inbox. Data is loaded in the browser (clientLoader) because the quotes API authenticates
 * with an App Bridge session token. The parent route (app.tsx) still runs `authenticate.admin` on the server.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ClientLoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useNavigation, useSearchParams, useRevalidator } from "react-router";
import { getBrowserClients } from "../lib/browser-client";
import type { InboxPage, StaffSummary } from "../lib/api-client";
import {
  INBOX_TABS,
  formatMoneyWhole,
  formatPct,
  isInboxTab,
  tabCount,
  waitingLabel,
} from "../lib/editor-state";
import { formatMoney, parseMoney } from "../lib/pricing";
import { safe, type StaffMember, type Team } from "../lib/proposed-api";
import { ErrorBanner, LoadingPage, StatusBadge, WaitingTimer, errorMessage, useNow } from "../components/common";

interface InboxData {
  page: InboxPage | null;
  summary: StaffSummary | null;
  staff: StaffMember[];
  teams: Team[];
  error: string | null;
}

export const clientLoader = async ({ request }: ClientLoaderFunctionArgs): Promise<InboxData> => {
  const url = new URL(request.url);
  const tabParam = url.searchParams.get("tab");
  const tab = isInboxTab(tabParam) ? tabParam : "needs_response";
  const { staff, settings } = getBrowserClients();
  const [list, summary, staffList, teamList] = await Promise.all([
    staff
      .listQuotes({
        tab,
        q: url.searchParams.get("q") ?? undefined,
        rep: url.searchParams.get("rep") ?? undefined,
        team: url.searchParams.get("team") ?? undefined,
        limit: 50,
      })
      .then((page) => ({ page, error: null as string | null }))
      .catch((e: unknown) => ({ page: null, error: errorMessage(e) })),
    staff.summary().catch(() => null),
    safe(() => settings.listStaff().then((r) => r.items), [] as StaffMember[]),
    safe(() => settings.listTeams().then((r) => r.items), [] as Team[]),
  ]);
  return { page: list.page, error: list.error, summary, staff: staffList.data, teams: teamList.data };
};
clientLoader.hydrate = true as const;

export function HydrateFallback() {
  return <LoadingPage heading="Quote inbox" />;
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "warning" }) {
  return (
    <s-box padding="base" border="base" borderRadius="base" background="base">
      <s-stack gap="small-300">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        {sub ? <s-text tone={tone === "warning" ? "caution" : undefined} color={tone ? undefined : "subdued"}>{sub}</s-text> : null}
      </s-stack>
    </s-box>
  );
}

export default function Inbox() {
  const data = useLoaderData<typeof clientLoader>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [params, setParams] = useSearchParams();
  const now = useNow();

  const tabParam = params.get("tab");
  const tab = isInboxTab(tabParam) ? tabParam : "needs_response";
  const rep = params.get("rep") ?? "";
  const team = params.get("team") ?? "";

  const [search, setSearch] = useState(params.get("q") ?? "");
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // "Load more" pages are appended locally and reset whenever the loader data changes.
  const [extra, setExtra] = useState<InboxPage["items"]>([]);
  const [cursor, setCursor] = useState<string | null>(data.page?.nextCursor ?? null);
  const [moreError, setMoreError] = useState<string | null>(null);
  useEffect(() => {
    setExtra([]);
    setCursor(data.page?.nextCursor ?? null);
  }, [data]);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: key === "q" });
  };

  const onSearch = (value: string) => {
    setSearch(value);
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setParam("q", value.trim()), 350);
  };

  const rows = useMemo(() => [...(data.page?.items ?? []), ...extra], [data.page, extra]);
  const loading = navigation.state === "loading";

  const loadMore = async () => {
    if (!cursor) return;
    setMoreError(null);
    try {
      const page = await getBrowserClients().staff.listQuotes({
        tab,
        q: params.get("q") ?? undefined,
        rep: rep || undefined,
        team: team || undefined,
        cursor,
        limit: 50,
      });
      setExtra((e) => [...e, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      setMoreError(errorMessage(e));
    }
  };

  const s = data.summary;
  const oldestWaiting = useMemo(() => {
    const times = rows.filter((r) => r.waitingOn === "sales" && r.waitingSince).map((r) => r.waitingSince as string);
    times.sort();
    return times[0];
  }, [rows]);

  return (
    <s-page heading="Quote inbox">
      <s-button slot="primary-action" variant="primary" commandFor="create-quote-modal" command="--show">
        Create quote for customer
      </s-button>
      <s-button slot="secondary-actions" onClick={() => revalidator.revalidate()} loading={revalidator.state === "loading"}>
        Refresh
      </s-button>

      <CreateQuoteModal onCreated={(id) => navigate(`/app/quotes/${encodeURIComponent(id)}`)} />

      <ErrorBanner message={data.error} />

      <s-section>
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
          <Tile
            label="Needs response"
            value={String(s?.needsResponse ?? 0)}
            sub={tab === "needs_response" && oldestWaiting ? `Oldest waiting ${waitingLabel(oldestWaiting, now)}` : undefined}
            tone="warning"
          />
          <Tile label="Open quote value" value={formatMoneyWhole(s?.openValue)} sub={s ? `${s.unassigned ?? 0} unassigned` : undefined} />
          <Tile
            label="Accepted this week"
            value={String(s?.acceptedThisWeek ?? 0)}
            sub={s?.acceptedThisWeekValue ? formatMoneyWhole(s.acceptedThisWeekValue) : undefined}
          />
          <Tile label="Expiring in 3 days" value={String(s?.expiringSoon ?? 0)} sub="Nudge sent automatically" />
        </s-grid>
      </s-section>

      <s-section padding="none" accessibilityLabel="Quotes">
        <s-box padding="small">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            {INBOX_TABS.map((t) => {
              const n = tabCount(t.id, s);
              return (
                <s-button
                  key={t.id}
                  variant={t.id === tab ? "secondary" : "tertiary"}
                  accessibilityLabel={`${t.label}${n !== undefined ? `, ${n}` : ""}${t.id === tab ? ", selected" : ""}`}
                  onClick={() => setParam("tab", t.id === "needs_response" ? "" : t.id)}
                >
                  {t.label}
                  {n !== undefined ? ` · ${n}` : ""}
                </s-button>
              );
            })}
          </s-stack>
        </s-box>

        <s-box padding="small">
          <s-grid gridTemplateColumns="2fr 1fr 1fr" gap="small">
            <s-search-field
              label="Search"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search company, job, PO, quote #"
              value={search}
              onInput={(e) => onSearch(e.currentTarget.value)}
            />
            <s-select label="Rep" value={rep} onChange={(e) => setParam("rep", e.currentTarget.value)}>
              <s-option value="">Anyone</s-option>
              <s-option value="me">Me</s-option>
              <s-option value="unassigned">Unassigned</s-option>
              {data.staff.map((m) => (
                <s-option key={m.id} value={m.id}>
                  {m.name}
                </s-option>
              ))}
            </s-select>
            <s-select label="Team" value={team} onChange={(e) => setParam("team", e.currentTarget.value)}>
              <s-option value="">All teams</s-option>
              {data.teams.map((t) => (
                <s-option key={t.id} value={t.id}>
                  {t.name}
                </s-option>
              ))}
            </s-select>
          </s-grid>
        </s-box>

        <s-table loading={loading}>
          <s-table-header-row>
            <s-table-header listSlot="primary">Quote</s-table-header>
            <s-table-header>Company · Job</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header>Waiting</s-table-header>
            <s-table-header>Rep</s-table-header>
            <s-table-header format="currency">Total</s-table-header>
            <s-table-header format="numeric">Margin</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rows.map((r) => (
              <s-table-row key={r.id}>
                <s-table-cell>
                  <s-link href={`/app/quotes/${encodeURIComponent(r.id)}`}>{r.displayNumber ?? `Q-${r.number}`}</s-link>
                </s-table-cell>
                <s-table-cell>
                  <s-stack gap="small-500">
                    <s-text type="strong">{r.companyName ?? r.customerName}</s-text>
                    <s-text color="subdued">{[r.jobName, r.title].filter(Boolean).join(" — ")}</s-text>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  <StatusBadge status={r.status} />
                </s-table-cell>
                <s-table-cell>{r.waitingOn === "sales" ? <WaitingTimer since={r.waitingSince} now={now} /> : <s-text color="subdued">n/a</s-text>}</s-table-cell>
                <s-table-cell>
                  {r.assignedRepName ? <s-text>{r.assignedRepName}</s-text> : <s-badge tone="warning">Unassigned</s-badge>}
                </s-table-cell>
                <s-table-cell>{formatMoney(parseMoney(r.total) ?? 0)}</s-table-cell>
                <s-table-cell>
                  {r.belowFloor ? <s-badge tone="critical">{formatPct(r.marginPct)}</s-badge> : formatPct(r.marginPct)}
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>

        {rows.length === 0 && !data.error ? (
          <s-box padding="large">
            <s-text color="subdued">No quotes match these filters.</s-text>
          </s-box>
        ) : null}

        {cursor ? (
          <s-box padding="base">
            <s-button onClick={loadMore}>Load more</s-button>
          </s-box>
        ) : null}
        <ErrorBanner message={moreError} onDismiss={() => setMoreError(null)} />
      </s-section>
    </s-page>
  );
}

/** "Create quote for customer": minimal form. See report: a staff customer search endpoint would improve this. */
function CreateQuoteModal({ onCreated }: { onCreated: (id: string) => void }) {
  const [customerId, setCustomerId] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!customerId.trim() || !title.trim()) {
      setError("Customer ID and a title are required.");
      return;
    }
    setBusy(true);
    try {
      const q = await getBrowserClients().staff.createQuote({ customerId: customerId.trim(), title: title.trim(), submit: false });
      onCreated(q.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <s-modal id="create-quote-modal" heading="Create quote for customer">
      <s-stack gap="base">
        <ErrorBanner message={error} />
        <s-text-field
          label="Customer ID"
          details="Shopify customer GID, e.g. gid://shopify/Customer/123"
          value={customerId}
          onInput={(e) => setCustomerId(e.currentTarget.value)}
        />
        <s-text-field label="Quote title" value={title} onInput={(e) => setTitle(e.currentTarget.value)} />
      </s-stack>
      <s-button slot="primary-action" variant="primary" loading={busy} onClick={submit}>
        Create
      </s-button>
      <s-button slot="secondary-actions" commandFor="create-quote-modal" command="--hide">
        Cancel
      </s-button>
    </s-modal>
  );
}
