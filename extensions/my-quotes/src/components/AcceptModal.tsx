// Accept -> confirm dialog -> POST /accept -> POST /checkout -> hand the customer the returned URL.
//
// Platform limit: the Navigation API "can only navigate within the customer accounts surface. It
// can't redirect to external URLs or the storefront" (Shopify docs), and the extension has no
// window. So after /checkout succeeds the dialog turns into a success state whose primary button is a
// real link (`href`) to the invoice/checkout URL. One extra click, no way around it.
import { useEffect, useState } from "preact/hooks";
import { api } from "../api/instance";
import type { CustomerQuote } from "../api/types";
import { currentVersionNo } from "../lib/detail";
import {
  ASK_NEW_QUOTE_LABEL,
  REVIEW_NEW_VERSION_LABEL,
  isNotPurchasableError,
  isVersionMismatchError,
  versionMismatchMessage,
} from "../lib/errors";
import { formatLongDate, formatMoney } from "../lib/format";
import { errorMessage } from "../ui/common";
import { go, useAction } from "../ui/hooks";
import { ACCEPT_MODAL_ID } from "./StatusBannerView";

export function AcceptModal({
  quote,
  onQuote,
  onReview,
}: {
  quote: CustomerQuote;
  /** Called with the quote returned by /accept so the page behind the dialog updates. */
  onQuote: (q: CustomerQuote) => void;
  onReview: () => void;
}) {
  const action = useAction();
  const [url, setUrl] = useState<string | undefined>(undefined);
  const versionNo = currentVersionNo(quote);
  const number = quote.displayNumber ?? `Q-${quote.number}`;

  async function accept() {
    // If a previous attempt accepted but /checkout failed, do not accept twice.
    if (quote.status !== "ACCEPTED") {
      const accepted = await action.run("accept", () => api().acceptQuote(quote.id, versionNo));
      if (!accepted) return;
      onQuote(accepted);
    }
    const checkout = await action.run("checkout", () => api().checkout(quote.id));
    if (checkout) setUrl(checkout.invoiceUrl);
  }

  async function askForNew() {
    const copy = await action.run("duplicate", () => api().duplicateQuote(quote.id));
    if (copy) go({ name: "detail", id: copy.id });
  }

  const err = action.error;
  const stale = isVersionMismatchError(err);
  const notPurchasable = isNotPurchasableError(err);
  const working = action.busy === "accept" || action.busy === "checkout";

  // Stale accept: reload the quote and jump to the new version tab straight away, so the page behind
  // the dialog already shows what the customer must re-review.
  useEffect(() => {
    if (stale) onReview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [err]);

  function review() {
    action.clearError();
  }

  return (
    <s-modal id={ACCEPT_MODAL_ID} heading={url ? "Quote accepted" : "Accept this quote?"}>
      <s-stack direction="block" gap="base">
        {url ? (
          <s-banner tone="success" heading="You are all set">
            Prices are locked. Continue to checkout to place your order.
          </s-banner>
        ) : (
          <s-text>
            Accept {number}
            {versionNo ? ` (version ${versionNo})` : ""} for {formatMoney(quote.total, quote.currencyCode)}?
            {quote.expiresAt ? ` Prices are held until ${formatLongDate(quote.expiresAt)}.` : ""} You will go straight to
            checkout to place the order.
          </s-text>
        )}
        {err ? (
          <s-banner tone="critical" heading={stale ? "This quote changed" : "Could not complete"}>
            <s-stack direction="block" gap="small">
              <s-text>{stale ? versionMismatchMessage(err) : errorMessage(err)}</s-text>
              {stale ? (
                <s-stack direction="inline">
                  <s-button variant="primary" commandFor={ACCEPT_MODAL_ID} command="--hide" onClick={review}>
                    {REVIEW_NEW_VERSION_LABEL}
                  </s-button>
                </s-stack>
              ) : null}
              {notPurchasable ? (
                <s-stack direction="inline">
                  <s-button loading={action.busy === "duplicate"} onClick={() => void askForNew()}>
                    {ASK_NEW_QUOTE_LABEL}
                  </s-button>
                </s-stack>
              ) : null}
            </s-stack>
          </s-banner>
        ) : null}
      </s-stack>

      <s-button slot="secondary-actions" commandFor={ACCEPT_MODAL_ID} command="--hide">
        {url ? "Close" : "Cancel"}
      </s-button>
      {url ? (
        <s-button slot="primary-action" variant="primary" href={url}>
          Continue to checkout
        </s-button>
      ) : (
        <s-button
          slot="primary-action"
          variant="primary"
          loading={working}
          disabled={stale}
          onClick={() => void accept()}
        >
          {quote.status === "ACCEPTED" ? "Continue to checkout" : "Accept and checkout"}
        </s-button>
      )}
    </s-modal>
  );
}
