import { useRef, useState } from "preact/hooks";
import { api } from "../api/instance";
import type { CustomerQuote } from "../api/types";
import { errorMessage } from "../ui/common";
import { valueOf } from "../ui/events";
import { useAction } from "../ui/hooks";
import { CHANGES_MODAL_ID } from "./StatusBannerView";

export function RequestChangesModal({
  quote,
  onQuote,
}: {
  quote: CustomerQuote;
  onQuote: (q: CustomerQuote) => void;
}) {
  const [message, setMessage] = useState("");
  const action = useAction();
  const modal = useRef<HTMLElementTagNameMap["s-modal"]>(null);
  const valid = message.trim().length > 0;

  async function send() {
    if (!valid) return;
    const updated = await action.run("request-changes", () => api().requestChanges(quote.id, message.trim()));
    if (!updated) return;
    setMessage("");
    onQuote(updated);
    modal.current?.hideOverlay();
  }

  return (
    <s-modal ref={modal} id={CHANGES_MODAL_ID} heading="Request changes">
      <s-stack direction="block" gap="base">
        <s-text>Tell your rep what to change. They will send a revised version.</s-text>
        {action.error ? <s-banner tone="critical">{errorMessage(action.error)}</s-banner> : null}
        <s-text-area
          label="What should change?"
          rows={4}
          maxLength={5000}
          required
          placeholder="Lower the amp price, swap the 6.5-inch speakers for 8-inch…"
          value={message}
          onInput={(e: Event) => setMessage(valueOf(e))}
        />
      </s-stack>
      <s-button slot="secondary-actions" commandFor={CHANGES_MODAL_ID} command="--hide">
        Cancel
      </s-button>
      <s-button
        slot="primary-action"
        variant="primary"
        disabled={!valid}
        loading={action.busy === "request-changes"}
        onClick={() => void send()}
      >
        Send request
      </s-button>
    </s-modal>
  );
}
