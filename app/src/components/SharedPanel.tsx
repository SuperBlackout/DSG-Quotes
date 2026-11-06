import { useState } from "react";
import type { StaffQuote } from "../lib/api-client";

/**
 * Order and comments for a rep-created quote that is private (DRAFT) or shared for review (SHARED).
 * Every action here is applied to the server immediately (the lines are a shared document), so the panel is
 * disabled while the pricing table below has unsaved edits: save first, then restructure.
 */
export function SharedPanel({
  quote,
  disabled,
  busy,
  onReorder,
  onAddComment,
  onDeleteComment,
}: {
  quote: StaffQuote;
  disabled: boolean;
  busy: boolean;
  onReorder: (lineIds: string[]) => void;
  onAddComment: (c: { body: string; afterLineId: string | null; internal: boolean }) => Promise<boolean>;
  onDeleteComment: (id: string) => void;
}) {
  const lines = [...quote.workingLines].sort((a, b) => a.position - b.position);
  const comments = quote.comments ?? [];
  const shared = quote.status === "SHARED";
  const [target, setTarget] = useState<string | "top" | null>(null);
  const [text, setText] = useState("");
  const [internal, setInternal] = useState(!shared);

  const move = (i: number, dir: -1 | 1) => {
    const ids = lines.map((l) => l.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    onReorder(ids);
  };

  const submit = async () => {
    if (!text.trim() || target === null) return;
    const ok = await onAddComment({ body: text.trim(), afterLineId: target === "top" ? null : target, internal });
    if (ok) {
      setText("");
      setTarget(null);
    }
  };

  const commentsAfter = (lineId: string | null) => comments.filter((c) => (c.afterLineId ?? null) === lineId);

  const renderComment = (c: (typeof comments)[number]) => (
    <s-box key={c.id} padding="small" background="subdued" borderRadius="base">
      <s-stack direction="inline" gap="small-300" alignItems="center" justifyContent="space-between">
        <s-stack gap="small-500">
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-text type="strong">{c.authorName}</s-text>
            {c.internal ? <s-badge tone="caution">Internal, not shown to customer</s-badge> : c.authorType === "CUSTOMER" ? <s-badge tone="info">Customer</s-badge> : null}
          </s-stack>
          <s-text>{c.body}</s-text>
        </s-stack>
        <s-button variant="tertiary" tone="critical" icon="delete" accessibilityLabel="Delete comment" disabled={busy} onClick={() => onDeleteComment(c.id)} />
      </s-stack>
    </s-box>
  );

  const composer = (key: string | "top") =>
    target === key ? (
      <s-stack gap="small-300">
        <s-text-area label="Comment" rows={2} value={text} onInput={(e) => setText(e.currentTarget.value)} />
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-checkbox label="Internal only (customer will not see it)" checked={internal} onChange={(e) => setInternal(e.currentTarget.checked)} />
          <s-button variant="primary" disabled={!text.trim() || busy} onClick={submit}>
            Add comment
          </s-button>
          <s-button variant="tertiary" onClick={() => setTarget(null)}>
            Cancel
          </s-button>
        </s-stack>
      </s-stack>
    ) : (
      <s-button variant="tertiary" icon="chat" disabled={disabled || busy} onClick={() => setTarget(key)}>
        {key === "top" ? "Comment at top" : "Comment below"}
      </s-button>
    );

  return (
    <s-section heading="Order and comments" accessibilityLabel="Order and comments">
      <s-stack gap="small">
        {disabled ? <s-text color="subdued">Save your pricing changes first, then reorder or comment.</s-text> : null}
        {shared ? (
          <s-text color="subdued">The customer sees this order and every comment except those marked internal.</s-text>
        ) : (
          <s-text color="subdued">Private draft. Comments you mark customer-visible appear when you share it.</s-text>
        )}
        {composer("top")}
        {commentsAfter(null).map(renderComment)}
        {lines.map((l, i) => (
          <s-stack key={l.id} gap="small-300">
            <s-stack direction="inline" gap="small-300" alignItems="center" justifyContent="space-between">
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-text type="strong">{`${i + 1}. ${l.title}`}</s-text>
                <s-text color="subdued">{`qty ${l.qty}`}</s-text>
                {l.addedBy === "CUSTOMER" ? <s-badge tone="info">Added by customer</s-badge> : null}
              </s-stack>
              <s-stack direction="inline" gap="small-500">
                <s-button variant="tertiary" icon="arrow-up" accessibilityLabel={`Move ${l.title} up`} disabled={disabled || busy || i === 0} onClick={() => move(i, -1)} />
                <s-button variant="tertiary" icon="arrow-down" accessibilityLabel={`Move ${l.title} down`} disabled={disabled || busy || i === lines.length - 1} onClick={() => move(i, 1)} />
              </s-stack>
            </s-stack>
            {commentsAfter(l.id).map(renderComment)}
            {composer(l.id)}
          </s-stack>
        ))}
      </s-stack>
    </s-section>
  );
}
