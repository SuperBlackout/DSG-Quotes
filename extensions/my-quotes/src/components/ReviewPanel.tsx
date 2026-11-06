// "Review" card for a quote a rep shared for collaboration (status SHARED): the items in order with the rep's
// and the customer's comments between lines. Everything here is applied to the server immediately.
// Prices are deliberately not shown: they are set by the rep and only become binding when the quote is sent.
import { useState } from "preact/hooks";
import { api } from "../api/instance";
import type { CustomerLineComment, CustomerQuote } from "../api/types";

type Run = <T>(name: string, fn: () => Promise<T>) => Promise<T | undefined>;

export function ReviewPanel({
  quote,
  onQuote,
  run,
  busy,
}: {
  quote: CustomerQuote;
  onQuote: (q: CustomerQuote) => void;
  run: Run;
  busy: boolean;
}) {
  const lines = [...quote.lines].sort((a, b) => a.position - b.position);
  const comments = quote.comments ?? [];
  const canEdit = quote.actions.canEditLines;
  const rev = quote.rev ?? 0;
  const [target, setTarget] = useState<string | "top" | undefined>(undefined);
  const [text, setText] = useState("");

  const commentsAfter = (lineId: string | null) => comments.filter((c) => (c.afterLineId ?? null) === lineId);

  async function move(i: number, dir: -1 | 1) {
    const ids = lines.map((l) => l.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    const res = await run("reorder", () => api().reorderLines(quote.id, { lineIds: ids, rev }));
    if (res) onQuote(res);
  }

  async function setQty(lineId: string, value: string) {
    const qty = Number(value);
    if (!Number.isInteger(qty) || qty < 1) return;
    const res = await run("qty", () => api().updateLine(quote.id, lineId, { qty }));
    if (res) onQuote(res);
  }

  async function remove(lineId: string) {
    const res = await run("remove", () => api().deleteLine(quote.id, lineId));
    if (res) onQuote(res);
  }

  async function addComment() {
    const body = text.trim();
    if (!body || target === undefined) return;
    const res = await run("comment", () => api().addComment(quote.id, { body, afterLineId: target === "top" ? null : target }));
    if (res) {
      onQuote(res);
      setText("");
      setTarget(undefined);
    }
  }

  async function deleteComment(id: string) {
    const res = await run("comment-delete", () => api().deleteComment(quote.id, id));
    if (res) onQuote(res);
  }

  const renderComment = (c: CustomerLineComment) => (
    <s-box key={c.id} background="subdued" padding="base" borderRadius="base">
      <s-stack direction="inline" gap="small" alignItems="center" justifyContent="space-between">
        <s-stack direction="block" gap="small-300">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text type="strong">{c.mine ? "You" : c.authorName}</s-text>
            {c.authorType === "STAFF" ? <s-badge tone="auto">DSG</s-badge> : null}
          </s-stack>
          <s-text>{c.body}</s-text>
        </s-stack>
        {c.mine && canEdit ? (
          <s-button variant="secondary" tone="critical" accessibilityLabel="Delete comment" disabled={busy} onClick={() => void deleteComment(c.id)}>
            Delete
          </s-button>
        ) : null}
      </s-stack>
    </s-box>
  );

  const composer = (key: string | "top", label: string) =>
    target === key ? (
      <s-stack direction="block" gap="small-200">
        <s-text-area
          label="Comment"
          rows={2}
          value={text}
          onInput={(e: Event) => setText((e.currentTarget as HTMLInputElement).value)}
        />
        <s-stack direction="inline" gap="small-200">
          <s-button variant="primary" disabled={busy || !text.trim()} onClick={() => void addComment()}>
            Add comment
          </s-button>
          <s-button variant="secondary" onClick={() => setTarget(undefined)}>
            Cancel
          </s-button>
        </s-stack>
      </s-stack>
    ) : canEdit ? (
      <s-button variant="secondary" disabled={busy} onClick={() => setTarget(key)}>
        {label}
      </s-button>
    ) : null;

  return (
    <s-section heading="Review items">
      <s-stack direction="block" gap="base">
        {!canEdit ? <s-banner tone="info">This quote can no longer be edited.</s-banner> : null}
        {composer("top", "Comment at the top")}
        {commentsAfter(null).map(renderComment)}
        {lines.length === 0 ? <s-text color="subdued">No items on this quote yet.</s-text> : null}
        {lines.map((line, i) => (
          <s-stack key={line.id} direction="block" gap="small-200">
            <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
              <s-stack direction="block" gap="small-300">
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-text type="strong">{`${i + 1}. ${line.title}`}</s-text>
                  {line.addedBy === "STAFF" ? <s-badge tone="auto">Added by DSG</s-badge> : null}
                </s-stack>
                <s-text color="subdued" type="small">
                  {[line.sku, line.lineNote ? `"${line.lineNote}"` : undefined].filter(Boolean).join(" · ")}
                </s-text>
              </s-stack>
              {canEdit ? (
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-number-field
                    label={`Quantity for ${line.title}`}
                    labelAccessibilityVisibility="exclusive"
                    min={1}
                    step={1}
                    value={String(line.qty)}
                    disabled={busy}
                    onChange={(e: Event) => void setQty(line.id, (e.currentTarget as HTMLInputElement).value)}
                  />
                  <s-button variant="secondary" accessibilityLabel={`Move ${line.title} up`} disabled={busy || i === 0} onClick={() => void move(i, -1)}>
                    Up
                  </s-button>
                  <s-button
                    variant="secondary"
                   
                    accessibilityLabel={`Move ${line.title} down`}
                    disabled={busy || i === lines.length - 1}
                    onClick={() => void move(i, 1)}
                  >
                    Down
                  </s-button>
                  <s-button variant="secondary" tone="critical" accessibilityLabel={`Remove ${line.title}`} disabled={busy} onClick={() => void remove(line.id)}>
                    Remove
                  </s-button>
                </s-stack>
              ) : (
                <s-text>{`Qty ${line.qty}`}</s-text>
              )}
            </s-grid>
            {commentsAfter(line.id).map(renderComment)}
            {composer(line.id, "Comment below")}
          </s-stack>
        ))}
        <s-text color="subdued" type="small">
          Want to add something? Use Add to Quote on the store and your rep will see it here, or leave a comment above.
        </s-text>
      </s-stack>
    </s-section>
  );
}
