/**
 * Screen 7: sales quote editor. Loads in the browser (clientLoader) with the App Bridge session token.
 * All money / margin / floor logic lives in ../lib/pricing.ts; this file only wires UI to it.
 */
import { useMemo, useState } from "react";
import type { ClientLoaderFunctionArgs } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useLoaderData, useRouteError } from "react-router";
import { ApiError, type StaffMessage, type StaffQuote } from "../lib/api-client";
import { getBrowserClients } from "../lib/browser-client";
import {
  STATUS_LABEL,
  diffAgainstVersion,
  isDirty,
  nextVersionNo,
  quoteActions,
  stateFromQuote,
  toDraftRequest,
  validateEditor,
  waitingLabel,
  type EditorState,
} from "../lib/editor-state";
import { addVariants, applyDiscountToAll, fromPickerItem, removeLine, setQty, setQuotedPrice, updateLine } from "../lib/editor-ops";
import { computeTotals, floorViolations, formatMoney, parseMoney, toMoneyString } from "../lib/pricing";
import {
  DEFAULT_SAVED_REPLIES,
  DEFAULT_SETTINGS,
  safe,
  type QuoteSettings,
  type SavedReply,
  type StaffMe,
  type StaffMember,
  type Team,
} from "../lib/proposed-api";
import { CommitField } from "../components/CommitField";
import { Conversation } from "../components/Conversation";
import { CustomerPreview } from "../components/CustomerPreview";
import { LinesTable } from "../components/LinesTable";
import { ErrorBanner, LoadingPage, StatusBadge, errorMessage, useNow } from "../components/common";

interface EditorData {
  quote: StaffQuote;
  me: StaffMe | null;
  staff: StaffMember[];
  teams: Team[];
  settings: QuoteSettings;
  savedReplies: SavedReply[];
}

export const clientLoader = async ({ params }: ClientLoaderFunctionArgs): Promise<EditorData> => {
  const id = params["id"];
  if (!id) throw new Response("Missing quote id", { status: 400 });
  const { staff, settings } = getBrowserClients();
  const [quote, me, staffList, teams, cfg, replies] = await Promise.all([
    staff.getQuote(id),
    safe(() => settings.me(), null as StaffMe | null),
    safe(() => settings.listStaff().then((r) => r.items), [] as StaffMember[]),
    safe(() => settings.listTeams().then((r) => r.items), [] as Team[]),
    safe(() => settings.getSettings(), DEFAULT_SETTINGS),
    safe(() => settings.listSavedReplies().then((r) => r.items), DEFAULT_SAVED_REPLIES),
  ]);
  return {
    quote,
    me: me.data,
    staff: staffList.data,
    teams: teams.data,
    settings: cfg.data,
    savedReplies: replies.data.length > 0 ? replies.data : DEFAULT_SAVED_REPLIES,
  };
};
clientLoader.hydrate = true as const;

export function HydrateFallback() {
  return <LoadingPage heading="Quote" />;
}

export function ErrorBoundary() {
  const err = useRouteError();
  const message = err instanceof ApiError || err instanceof Error ? err.message : "Could not load this quote.";
  return (
    <s-page heading="Quote">
      <s-link slot="breadcrumb-actions" href="/app">
        Inbox
      </s-link>
      <ErrorBanner message={message} />
    </s-page>
  );
}

export default function QuoteEditorRoute() {
  const data = useLoaderData<typeof clientLoader>();
  return <QuoteEditor key={data.quote.id} data={data} />;
}

function QuoteEditor({ data }: { data: EditorData }) {
  const shopify = useAppBridge();
  const { staff: api } = getBrowserClients();
  const now = useNow();

  const [quote, setQuote] = useState<StaffQuote>(data.quote);
  const [state, setState] = useState<EditorState>(() => stateFromQuote(data.quote));
  const savedState = useMemo(() => stateFromQuote(quote), [quote]);
  const dirty = isDirty(state, savedState);

  const [busy, setBusy] = useState<null | "save" | "send" | "claim" | "assign" | "approve" | "reopen" | "decline">(null);
  const [error, setError] = useState<string | null>(null);
  const [floorIds, setFloorIds] = useState<string[]>([]);
  const [approvalRequested, setApprovalRequested] = useState(false);
  const [discountText, setDiscountText] = useState("5");
  const [declineReason, setDeclineReason] = useState("");

  const { me, settings } = data;
  const floorPct = me?.priceFloorPct ?? settings.defaultPriceFloorPct;
  const actions = quoteActions(quote.status);
  const readOnly = !actions.canEdit;
  const versionNo = nextVersionNo(quote);
  const lastSent = [...quote.versions].sort((a, b) => b.versionNo - a.versionNo)[0];
  const changes = useMemo(() => diffAgainstVersion(state.lines, lastSent?.lines), [state.lines, lastSent]);
  const totals = computeTotals(state.lines, state.freightCents);
  const violations = floorViolations(state.lines, floorPct);
  const validation = validateEditor(state);
  const number = quote.displayNumber ?? `Q-${quote.number}`;
  const assignedValue = quote.assignedRepId ? `rep:${quote.assignedRepId}` : quote.teamId ? `team:${quote.teamId}` : "";
  const isMine = !!me && quote.assignedRepId === me.id;

  const adopt = (q: StaffQuote) => {
    setQuote(q);
    setState(stateFromQuote(q));
    setFloorIds([]);
  };

  const run = async <T,>(kind: NonNullable<typeof busy>, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(kind);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ApiError && e.code === "FLOOR_APPROVAL_REQUIRED") setFloorIds(e.floorLineIds);
      setError(errorMessage(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  const saveDraft = async (): Promise<StaffQuote | undefined> => {
    if (validation.length > 0) {
      setError(validation[0] ?? "Fix the highlighted problems first.");
      return undefined;
    }
    const q = await run("save", () => api.saveDraft(quote.id, toDraftRequest(state)));
    if (q) {
      adopt(q);
      shopify.toast.show("Draft saved");
    }
    return q;
  };

  const sendRevision = async () => {
    if (validation.length > 0) {
      setError(validation[0] ?? "Fix the highlighted problems first.");
      return;
    }
    const q = await run("send", async () => {
      if (dirty) await api.saveDraft(quote.id, toDraftRequest(state));
      return api.send(quote.id);
    });
    if (q) {
      adopt(q);
      shopify.toast.show(`Sent v${nextVersionNo(q) - 1} to customer`);
    }
  };

  const claim = async () => {
    const q = await run("claim", () => api.claim(quote.id));
    if (q) setQuote(q);
  };

  const assign = async (value: string) => {
    const body = value.startsWith("rep:")
      ? { repId: value.slice(4), teamId: null }
      : value.startsWith("team:")
        ? { repId: null, teamId: value.slice(5) }
        : { repId: null, teamId: null };
    const q = await run("assign", () => api.assign(quote.id, body));
    if (q) setQuote((prev) => ({ ...prev, ...q, workingLines: prev.workingLines }));
  };

  /**
   * Managers approve flagged lines directly. Reps "request" approval: with no dedicated endpoint in the
   * contract yet, this saves the draft and posts an internal note naming the lines (see report).
   */
  const requestOrGrantApproval = async () => {
    const saved = await saveDraft();
    if (!saved) return;
    if (me?.isManager) {
      const q = await run("approve", () => api.approveFloor(quote.id, {}));
      if (q) {
        adopt(q);
        shopify.toast.show("Floor exceptions approved");
      }
      return;
    }
    const names = floorViolations(stateFromQuote(saved).lines, floorPct)
      .map((v) => `${v.line.sku ?? v.line.title} at ${v.marginPct ?? "?"}%`)
      .join(", ");
    const msg = await run("approve", () =>
      api.postMessage(quote.id, {
        internal: true,
        body: `Manager approval requested for ${number} (floor ${floorPct}%): ${names || "flagged lines"}.`,
      }),
    );
    if (msg) {
      setQuote((prev) => ({ ...prev, messages: [...prev.messages, msg] }));
      setApprovalRequested(true);
      shopify.toast.show("Approval requested from a manager");
    }
  };

  const reopen = async () => {
    const q = await run("reopen", () => api.reopen(quote.id));
    if (q) adopt(q);
  };

  const decline = async () => {
    const q = await run("decline", () => api.decline(quote.id, { reason: declineReason.trim() || undefined }));
    if (q) {
      adopt(q);
      setDeclineReason("");
    }
  };

  const addProducts = async () => {
    try {
      const picked = await shopify.resourcePicker({ type: "variant", multiple: true, action: "select" });
      if (!picked) return;
      const variants = (Array.from(picked as unknown as unknown[]) as unknown[])
        .map(fromPickerItem)
        .filter((v): v is NonNullable<typeof v> => v !== null);
      if (variants.length > 0) setState((s) => addVariants(s, variants));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const sendMessage = async (body: string, internal: boolean) => {
    const m: StaffMessage = await api.postMessage(quote.id, { body, internal });
    setQuote((prev) => ({ ...prev, messages: [...prev.messages, m] }));
  };

  const applyDiscount = () => {
    const pct = Number(discountText);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      setError("Enter a discount between 0 and 100.");
      return;
    }
    setState((s) => applyDiscountToAll(s, pct));
  };

  const statusLine = quote.latestChangeRequest ? waitingLabel(quote.waitingSince, now) : "";
  const customerFirst = quote.customerName.split(" ")[0] ?? quote.customerName;
  const hasUnsetCost = totals.marginPartial;

  return (
    <s-page heading={`${number} · ${quote.title}`} inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app">
        Inbox
      </s-link>
      <s-stack slot="header-badges" direction="inline" gap="small-300">
        <StatusBadge status={quote.status} />
        {actions.canEdit ? <s-badge tone="warning">{dirty ? `Editing v${versionNo} draft · unsaved` : `Editing v${versionNo} draft`}</s-badge> : null}
      </s-stack>
      <s-button slot="secondary-actions" commandFor="preview-modal" command="--show">
        Preview as customer
      </s-button>
      <s-button slot="secondary-actions" onClick={saveDraft} loading={busy === "save"} disabled={readOnly || !dirty}>
        Save draft
      </s-button>
      <s-button
        slot="primary-action"
        variant="primary"
        commandFor="send-modal"
        command="--show"
        disabled={!actions.canSend || busy !== null || validation.length > 0}
      >
        {`Send v${versionNo} to customer`}
      </s-button>

      {/* ------------------------------------------------------------------ banners */}
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      {floorIds.length > 0 ? (
        <s-banner tone="critical" heading="Manager approval needed to send">
          The server found {floorIds.length} line{floorIds.length === 1 ? "" : "s"} under the price floor. Raise the price or request
          approval.
        </s-banner>
      ) : null}
      {quote.latestChangeRequest ? (
        <s-banner tone="warning" heading={`Customer asked for changes${statusLine ? ` · ${statusLine} ago` : ""}`}>
          <s-paragraph>“{quote.latestChangeRequest}” — {quote.customerName}</s-paragraph>
        </s-banner>
      ) : null}
      {readOnly ? (
        <s-banner tone="info" heading={`This quote is ${STATUS_LABEL[quote.status].toLowerCase()}`}>
          Editing is disabled in this state.
          {actions.canReopen ? (
            <s-button slot="secondary-actions" onClick={reopen} loading={busy === "reopen"}>
              Reopen for changes
            </s-button>
          ) : null}
        </s-banner>
      ) : null}
      {actions.canClaim && !isMine ? (
        <s-banner tone="info" heading={quote.assignedRepName ? `Assigned to ${quote.assignedRepName}` : "Nobody owns this quote yet"}>
          <s-button slot="secondary-actions" onClick={claim} loading={busy === "claim"}>
            Claim this quote
          </s-button>
        </s-banner>
      ) : null}

      {/* ------------------------------------------------------------------ header */}
      <s-section heading="Quote details" accessibilityLabel="Quote header">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
          <s-stack gap="small-500">
            <s-text color="subdued">Customer</s-text>
            <s-text type="strong">{quote.companyName ?? quote.customerName}</s-text>
            <s-text>{quote.customerName}</s-text>
          </s-stack>
          <s-stack gap="small-500">
            <s-text color="subdued">Job · PO</s-text>
            <s-text type="strong">{quote.job?.name ?? quote.jobName ?? "No job"}</s-text>
            <s-text>{quote.poNumber ? `PO ${quote.poNumber}` : "No PO"}</s-text>
          </s-stack>
          <s-select
            label="Assigned rep"
            value={assignedValue}
            disabled={busy === "assign" || (data.staff.length === 0 && data.teams.length === 0)}
            onChange={(e) => assign(e.currentTarget.value)}
          >
            <s-option value="">Unassigned</s-option>
            {data.staff.map((m) => (
              <s-option key={m.id} value={`rep:${m.id}`}>
                {m.name}
              </s-option>
            ))}
            {data.teams.map((t) => (
              <s-option key={t.id} value={`team:${t.id}`}>
                {t.name} (team)
              </s-option>
            ))}
            {data.staff.length === 0 && quote.assignedRepId ? (
              <s-option value={assignedValue}>{quote.assignedRepName ?? "Assigned rep"}</s-option>
            ) : null}
          </s-select>
          <s-date-field
            label="Prices good until"
            value={state.expiresOn}
            disabled={readOnly}
            onChange={(e) => setState((s) => ({ ...s, expiresOn: e.currentTarget.value }))}
          />
        </s-grid>
        {quote.notesToSales ? (
          <s-box padding="small" background="subdued" borderRadius="base">
            <s-text color="subdued">Customer note to sales: </s-text>
            <s-text>{quote.notesToSales}</s-text>
          </s-box>
        ) : null}
      </s-section>

      {/* ------------------------------------------------------------------ lines */}
      <s-section heading="Line items" padding="none" accessibilityLabel="Line items">
        <s-button slot="primary-action" onClick={addProducts} disabled={readOnly}>
          Add product
        </s-button>
        <LinesTable
          lines={state.lines}
          floorPct={floorPct}
          changes={changes}
          versionLabel={`v${versionNo}`}
          disabled={readOnly}
          onQty={(key, text) => setState((s) => setQty(s, key, text))}
          onPrice={(key, cents) => setState((s) => setQuotedPrice(s, key, cents))}
          onNote={(key, text) => setState((s) => updateLine(s, key, { lineNote: text }))}
          onRemove={(key) => setState((s) => removeLine(s, key))}
        />

        {violations.length > 0 ? (
          <s-box padding="base">
            <s-banner tone="critical" heading={`${violations.length} line${violations.length === 1 ? "" : "s"} below the ${floorPct}% floor`}>
              <s-stack gap="small-300">
                {violations.map((v) => (
                  <s-text key={v.line.key}>
                    {v.line.sku ?? v.line.title}: {v.marginPct?.toFixed(1)}% margin
                  </s-text>
                ))}
                {approvalRequested && !me?.isManager ? <s-text color="subdued">Approval requested. A manager will review it.</s-text> : null}
              </s-stack>
              <s-button slot="secondary-actions" onClick={requestOrGrantApproval} loading={busy === "approve"} disabled={readOnly}>
                {me?.isManager ? "Approve floor exceptions" : "Request manager approval"}
              </s-button>
            </s-banner>
          </s-box>
        ) : null}

        <s-box padding="base">
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))" gap="base" alignItems="start">
            <s-stack gap="small">
              <s-stack direction="inline" gap="small" alignItems="end">
                <s-number-field
                  label="Percent off dealer price"
                  value={discountText}
                  min={0}
                  max={100}
                  disabled={readOnly}
                  onInput={(e) => setDiscountText(e.currentTarget.value)}
                />
                <s-button onClick={applyDiscount} disabled={readOnly || state.lines.length === 0}>
                  Apply % off all lines
                </s-button>
              </s-stack>
            </s-stack>

            <s-stack gap="small-300" accessibilityLabel="Totals">
              <s-stack direction="inline" justifyContent="space-between">
                <s-text>Subtotal</s-text>
                <s-text>{formatMoney(totals.subtotalCents)}</s-text>
              </s-stack>
              <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                <s-text>Freight</s-text>
                <CommitField
                  label="Freight"
                  value={toMoneyString(state.freightCents)}
                  disabled={readOnly}
                  isValid={(t) => {
                    const c = parseMoney(t);
                    return c !== null && c >= 0;
                  }}
                  onValid={(t) => setState((s) => ({ ...s, freightCents: parseMoney(t) ?? 0 }))}
                />
              </s-stack>
              <s-stack direction="inline" justifyContent="space-between">
                <s-text>Tax</s-text>
                <s-text color="subdued">Calculated at checkout</s-text>
              </s-stack>
              <s-divider />
              <s-stack direction="inline" justifyContent="space-between">
                <s-text type="strong">Total</s-text>
                <s-text type="strong">{formatMoney(totals.totalCents)}</s-text>
              </s-stack>
              <s-stack direction="inline" justifyContent="space-between">
                <s-text>Quote margin</s-text>
                <s-text type="strong" tone={violations.length > 0 ? "critical" : undefined}>
                  {totals.marginPct === null ? "n/a" : `${totals.marginPct.toFixed(1)}%`}
                </s-text>
              </s-stack>
              {hasUnsetCost ? <s-text color="subdued">Some line costs are filled in when you save.</s-text> : null}
            </s-stack>
          </s-grid>
        </s-box>
      </s-section>

      {/* ------------------------------------------------------------------ notes */}
      <s-section heading="Notes" accessibilityLabel="Notes">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(260px, 1fr))" gap="base">
          <s-text-area
            label="Job notes for customer"
            details="Shows on the quote and PDF"
            rows={4}
            value={state.repNote}
            disabled={readOnly}
            onInput={(e) => setState((s) => ({ ...s, repNote: e.currentTarget.value }))}
          />
          <s-box padding="small" background="subdued" border="base" borderStyle="dashed" borderRadius="base">
            <s-text-area
              label="Internal note"
              details="Sales team only, never shown to the customer"
              rows={4}
              value={state.internalNote}
              disabled={readOnly}
              onInput={(e) => setState((s) => ({ ...s, internalNote: e.currentTarget.value }))}
            />
          </s-box>
        </s-grid>
      </s-section>

      {/* ------------------------------------------------------------------ conversation (aside) */}
      <s-section slot="aside" heading="Conversation" accessibilityLabel="Conversation">
        <Conversation
          messages={quote.messages}
          customerName={customerFirst}
          savedReplies={data.savedReplies}
          onSend={sendMessage}
        />
      </s-section>

      {/* ------------------------------------------------------------------ danger zone */}
      {actions.canDecline ? (
        <s-section heading="Close this quote">
          <s-button tone="critical" commandFor="decline-modal" command="--show">
            Decline quote
          </s-button>
        </s-section>
      ) : null}

      {/* ------------------------------------------------------------------ modals */}
      <CustomerPreview id="preview-modal" versionNo={versionNo} number={number} title={quote.title} state={state} />

      <s-modal id="send-modal" heading={`Send v${versionNo} to ${quote.customerName}?`}>
        <s-stack gap="small">
          <s-text>
            {state.lines.length} item{state.lines.length === 1 ? "" : "s"} · total {formatMoney(totals.totalCents)}
            {state.expiresOn ? ` · prices good until ${state.expiresOn}` : " · default expiry applies"}
          </s-text>
          <s-text color="subdued">The customer is notified by email and text. Any unsaved edits are saved first.</s-text>
          {violations.length > 0 ? (
            <s-banner tone="critical">
              {violations.length} line{violations.length === 1 ? " is" : "s are"} under the floor. Sending will be refused until a
              manager approves.
            </s-banner>
          ) : null}
        </s-stack>
        <s-button slot="primary-action" variant="primary" commandFor="send-modal" command="--hide" onClick={sendRevision}>
          {`Send v${versionNo}`}
        </s-button>
        <s-button slot="secondary-actions" commandFor="send-modal" command="--hide">
          Cancel
        </s-button>
      </s-modal>

      <s-modal id="decline-modal" heading="Decline this quote?">
        <s-stack gap="small">
          <s-text>The quote closes as Declined and the customer is told. This cannot be undone.</s-text>
          <s-text-area label="Reason (optional)" rows={3} value={declineReason} onInput={(e) => setDeclineReason(e.currentTarget.value)} />
        </s-stack>
        <s-button slot="primary-action" variant="primary" tone="critical" commandFor="decline-modal" command="--hide" onClick={decline}>
          Decline quote
        </s-button>
        <s-button slot="secondary-actions" commandFor="decline-modal" command="--hide">
          Keep open
        </s-button>
      </s-modal>
    </s-page>
  );
}
