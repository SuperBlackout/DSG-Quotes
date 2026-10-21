// Screen 4: quote detail.
import { useEffect, useState } from "preact/hooks";
import { api } from "../api/instance";
import type { CustomerQuote } from "../api/types";
import { AcceptModal } from "../components/AcceptModal";
import { Conversation } from "../components/Conversation";
import { ItemsPanel } from "../components/ItemsPanel";
import { JobDetails } from "../components/JobDetails";
import { RequestChangesModal } from "../components/RequestChangesModal";
import { StatusBannerView } from "../components/StatusBannerView";
import type { BannerActionId } from "../lib/status";
import { orderHref } from "../router";
import { ActionErrorBanner, ErrorBanner, Loading, NavLink, StatusBadge, WIDE_900 } from "../ui/common";
import { go, useAction, useAsync } from "../ui/hooks";

export function QuoteDetail({ id }: { id: string }) {
  const quote = useAsync(() => api().getQuote(id), [id]);
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [highlight, setHighlight] = useState(true);
  const [continueUrl, setContinueUrl] = useState<string | undefined>(undefined);
  const action = useAction();

  const q = quote.data;

  // PDF: the endpoint needs the Authorization header, so it is fetched, never linked. The Navigation
  // API cannot open files, so once fetched the button turns into a real link to the blob (same
  // pattern as "Continue to checkout").
  const [pdf, setPdf] = useState<{ key: string; url: string } | undefined>(undefined);
  useEffect(() => {
    const url = pdf?.url;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [pdf]);
  const pdfKey = `${id}:${selected ?? "current"}`;
  const hasSentVersion = (q?.versions.length ?? 0) > 0; // DRAFTs have no PDF (404)

  async function downloadPdf() {
    if (!q) return;
    const file = await action.run("pdf", () => api().downloadPdf(q.id, selected));
    if (file) setPdf({ key: pdfKey, url: URL.createObjectURL(file.blob) });
  }

  // A newer version arrived (rep sent a revision): jump back to the live one.
  useEffect(() => setSelected(undefined), [q?.currentVersion]);

  async function onBannerAction(actionId: BannerActionId) {
    if (!q) return;
    switch (actionId) {
      case "buy": {
        const res = await action.run("buy", () => api().checkout(q.id));
        if (res) setContinueUrl(res.invoiceUrl);
        else quote.reload();
        return;
      }
      case "submit": {
        const res = await action.run("submit", () => api().submitQuote(q.id));
        if (res) quote.set(res);
        return;
      }
      case "withdraw": {
        const res = await action.run("withdraw", () => api().withdrawQuote(q.id));
        if (res) quote.set(res);
        return;
      }
      case "reopen": {
        const res = await action.run("reopen", () => api().reopenQuote(q.id));
        if (res) quote.set(res);
        return;
      }
      case "ask-new-quote": {
        // "Ask for a new quote" = copy it into a fresh draft with re-snapshotted prices, ready to submit.
        const res = await action.run("ask-new-quote", () => api().duplicateQuote(q.id));
        if (res) go({ name: "detail", id: res.id });
        return;
      }
      case "view-order":
        navigation.navigate(orderHref(q.orderId));
        return;
      case "accept":
      case "request-changes":
        return; // opened by the banner button itself (dialogs)
    }
  }

  async function duplicate(source: CustomerQuote) {
    const res = await action.run("duplicate", () => api().duplicateQuote(source.id));
    if (res) go({ name: "detail", id: res.id });
  }

  if (quote.loading && !q) {
    return (
      <s-page heading="Quote">
        <NavLink slot="breadcrumb-actions" route={{ name: "list" }}>
          My Quotes
        </NavLink>
        <Loading label="Loading quote" />
      </s-page>
    );
  }

  if (!q) {
    return (
      <s-page heading="Quote">
        <NavLink slot="breadcrumb-actions" route={{ name: "list" }}>
          My Quotes
        </NavLink>
        {quote.error ? <ErrorBanner error={quote.error} onRetry={quote.reload} /> : null}
      </s-page>
    );
  }

  const number = q.displayNumber ?? `Q-${q.number}`;

  return (
    <s-page heading={`${number} · ${q.title}`} subheading={q.job?.name}>
      <NavLink slot="breadcrumb-actions" route={{ name: "list" }}>
        My Quotes
      </NavLink>
      {hasSentVersion ? (
        pdf && pdf.key === pdfKey ? (
          <s-button slot="secondary-actions" href={pdf.url} target="_blank">
            Open PDF
          </s-button>
        ) : (
          <s-button slot="secondary-actions" loading={action.busy === "pdf"} onClick={() => void downloadPdf()}>
            Download PDF
          </s-button>
        )
      ) : null}
      <s-button slot="secondary-actions" loading={action.busy === "duplicate"} onClick={() => void duplicate(q)}>
        Duplicate
      </s-button>

      <s-query-container>
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small" alignItems="center">
            <StatusBadge quote={q} />
          </s-stack>

          {quote.error ? <ErrorBanner error={quote.error} onRetry={quote.reload} /> : null}
          {action.error ? (
            <ActionErrorBanner
              error={action.error}
              onDismiss={action.clearError}
              onAskNewQuote={() => void onBannerAction("ask-new-quote")}
              askingNewQuote={action.busy === "ask-new-quote"}
            />
          ) : null}

          <StatusBannerView quote={q} busy={action.busy} continueUrl={continueUrl} onAction={(a) => void onBannerAction(a)} />

          <s-grid gridTemplateColumns={`${WIDE_900} 2fr 1fr, 1fr`} gap="base" alignItems="start">
            <s-stack direction="block" gap="base">
              <JobDetails quote={q} onQuote={quote.set} />
              <ItemsPanel
                quote={q}
                selected={selected}
                onSelect={setSelected}
                highlight={highlight}
                onHighlight={setHighlight}
              />
            </s-stack>
            <Conversation quote={q} />
          </s-grid>
        </s-stack>
      </s-query-container>

      <AcceptModal
        quote={q}
        onQuote={quote.set}
        onReview={() => {
          setSelected(undefined); // back to the live (new) version tab
          setHighlight(true); // show what changed
          quote.reload();
        }}
      />
      <RequestChangesModal quote={q} onQuote={quote.set} />
    </s-page>
  );
}
