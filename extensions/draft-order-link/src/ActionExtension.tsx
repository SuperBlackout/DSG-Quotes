import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { displayNumber, quoteAppLink, quoteNumberFromTags } from "./quote-tag";

/**
 * Admin action on the draft order details page (More actions > Open quote). Reads the draft order's tags,
 * finds `quote:Q-#####`, and links to the quote editor inside the app (`app:` protocol resolves the app URL).
 *
 * UNVERIFIED without a live store / Shopify CLI: target API shape in 2026-07, the `app:` link opening the
 * embedded route /app/q/<number>, and that the action modal can navigate away (we also call
 * shopify.close() on click).
 */
export default async () => {
  render(<Extension />, document.body);
};

const QUERY = `#graphql
  query DraftOrderQuoteTag($id: ID!) {
    draftOrder(id: $id) {
      id
      tags
    }
  }`;

type State = { kind: "loading" } | { kind: "none" } | { kind: "error"; message: string } | { kind: "found"; number: number };

function Extension() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const draftOrderId = shopify.data.selected?.[0]?.id;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!draftOrderId) return setState({ kind: "none" });
        const res = await shopify.query<{ draftOrder: { tags: string[] } | null }>(QUERY, { variables: { id: draftOrderId } });
        if (cancelled) return;
        if (res.errors?.length) return setState({ kind: "error", message: "Could not read this draft order." });
        const n = quoteNumberFromTags(res.data?.draftOrder?.tags);
        setState(n === null ? { kind: "none" } : { kind: "found", number: n });
      } catch {
        if (!cancelled) setState({ kind: "error", message: "Could not read this draft order." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draftOrderId]);

  const label = state.kind === "found" ? displayNumber(state.number) : "";

  return (
    <s-admin-action heading={label ? `Open quote ${label}` : "Open quote"}>
      {state.kind === "loading" ? <s-text>Looking up the quote…</s-text> : null}
      {state.kind === "none" ? <s-banner tone="info">This draft order was not created from a quote.</s-banner> : null}
      {state.kind === "error" ? <s-banner tone="critical">{state.message}</s-banner> : null}
      {state.kind === "found" ? (
        <s-stack gap="base">
          <s-text>This draft order was created from quote {label}. Open it to see the customer, versions and messages.</s-text>
        </s-stack>
      ) : null}
      {state.kind === "found" ? (
        <s-button slot="primary-action" variant="primary" href={quoteAppLink(state.number)} onClick={() => shopify.close()}>
          {`Open quote ${label}`}
        </s-button>
      ) : null}
      <s-button slot="secondary-actions" onClick={() => shopify.close()}>
        Close
      </s-button>
    </s-admin-action>
  );
}
