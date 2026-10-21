import { useState } from "react";
import type { StaffMessage } from "../lib/api-client";
import type { SavedReply } from "../lib/proposed-api";
import { ErrorBanner, errorMessage } from "./common";

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function MessageRow({ m }: { m: StaffMessage }) {
  const who = m.authorName ?? (m.authorType === "CUSTOMER" ? "Customer" : m.authorType === "SYSTEM" ? "System" : "Staff");
  const meta = `${who}${m.authorType === "CUSTOMER" ? " · customer" : ""}${m.channel !== "WEB" ? ` · via ${m.channel.toLowerCase()}` : ""} · ${fmtTime(m.createdAt)}`;
  if (m.authorType === "SYSTEM") {
    return (
      <s-text color="subdued">
        {m.body}
      </s-text>
    );
  }
  if (m.internal) {
    // Internal notes are visibly distinct: warning background, INTERNAL badge, and a staff-only label.
    return (
      <s-box padding="small" background="subdued" border="base" borderRadius="base" borderStyle="dashed">
        <s-stack gap="small-300">
          <s-badge tone="warning">Internal · staff only</s-badge>
          <s-paragraph>{m.body}</s-paragraph>
          <s-text color="subdued">
            {meta}
          </s-text>
        </s-stack>
      </s-box>
    );
  }
  const fromCustomer = m.authorType === "CUSTOMER";
  return (
    <s-box padding="small" background={fromCustomer ? "base" : "strong"} border="base" borderRadius="base">
      <s-stack gap="small-300">
        <s-paragraph>{m.body}</s-paragraph>
        <s-text color="subdued">
          {meta}
        </s-text>
      </s-stack>
    </s-box>
  );
}

export function Conversation({
  messages,
  customerName,
  savedReplies,
  disabled,
  onSend,
}: {
  messages: StaffMessage[];
  customerName: string;
  savedReplies: SavedReply[];
  disabled?: boolean;
  onSend: (body: string, internal: boolean) => Promise<void>;
}) {
  const [mode, setMode] = useState<"customer" | "internal">("customer");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const internal = mode === "internal";

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      await onSend(body, internal);
      setText("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <s-stack gap="base">
      <s-text color="subdued">Customer messages go out by email and text per their notification settings.</s-text>
      <s-stack gap="small">
        {messages.length === 0 ? <s-text color="subdued">No messages yet.</s-text> : null}
        {messages.map((m) => (
          <MessageRow key={m.id} m={m} />
        ))}
      </s-stack>
      <s-divider />
      <s-stack direction="inline" gap="small-300">
        <s-button
          variant={internal ? "tertiary" : "secondary"}
          accessibilityLabel={`To customer${internal ? "" : ", selected"}`}
          onClick={() => setMode("customer")}
        >
          To customer
        </s-button>
        <s-button
          variant={internal ? "secondary" : "tertiary"}
          accessibilityLabel={`Internal note${internal ? ", selected" : ""}`}
          onClick={() => setMode("internal")}
        >
          Internal note
        </s-button>
      </s-stack>
      {internal ? <s-banner tone="warning">Internal note. Only your team sees this; the customer is never notified.</s-banner> : null}
      <s-text-area
        label={internal ? "Internal note" : "Message"}
        labelAccessibilityVisibility="exclusive"
        rows={3}
        placeholder={internal ? "Note for your team…" : `Reply to ${customerName}…`}
        value={text}
        disabled={disabled}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-select
          label="Saved replies"
          labelAccessibilityVisibility="exclusive"
          value=""
          onChange={(e) => {
            const r = savedReplies.find((x) => x.id === e.currentTarget.value);
            if (r) setText((t) => (t.trim() ? `${t}\n${r.body}` : r.body));
            e.currentTarget.value = "";
          }}
        >
          <s-option value="">Saved replies…</s-option>
          {savedReplies.map((r) => (
            <s-option key={r.id} value={r.id}>
              {r.title}
            </s-option>
          ))}
        </s-select>
        <s-button variant="primary" loading={busy} disabled={disabled || text.trim() === ""} onClick={send}>
          {internal ? "Add note" : "Send"}
        </s-button>
      </s-stack>
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
    </s-stack>
  );
}
