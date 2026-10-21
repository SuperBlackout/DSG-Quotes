import { useRef, useState } from "react";
import type { SavedReply, StaffMessage } from "../lib/api-client";
import { validateAttachment } from "../lib/attachments";
import { ErrorBanner, errorMessage } from "./common";

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function Attachments({ items }: { items: StaffMessage["attachments"] | undefined }) {
  if (!items || items.length === 0) return null;
  return (
    <s-stack gap="small-500">
      {items.map((a) => (
        <s-link key={a.url} href={a.url} target="_blank">
          {a.name}
        </s-link>
      ))}
    </s-stack>
  );
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
          <Attachments items={m.attachments} />
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
        <Attachments items={m.attachments} />
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
  manageRepliesHref,
  disabled,
  onSend,
}: {
  messages: StaffMessage[];
  customerName: string;
  savedReplies: SavedReply[];
  manageRepliesHref?: string;
  disabled?: boolean;
  /** Uploads `files` (signed URL, PUT) and posts the message. Throws on failure; the draft is kept. */
  onSend: (body: string, internal: boolean, files: File[]) => Promise<void>;
}) {
  const [mode, setMode] = useState<"customer" | "internal">("customer");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const internal = mode === "internal";

  const addFiles = (list: FileList | null) => {
    const picked = Array.from(list ?? []);
    const bad = picked.map((f) => validateAttachment(f)).find((p) => p !== null);
    if (bad) setError(bad);
    else setError(null);
    setFiles((prev) => [...prev, ...picked.filter((f) => validateAttachment(f) === null)]);
    if (fileInput.current) fileInput.current.value = "";
  };

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      await onSend(body, internal, files);
      setText("");
      setFiles([]);
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
      <s-stack gap="small-300">
        <input
          ref={fileInput}
          type="file"
          multiple
          aria-label="Attach files"
          disabled={disabled || busy}
          onChange={(e) => addFiles(e.currentTarget.files)}
        />
        {files.map((f, i) => (
          <s-stack key={`${f.name}-${i}`} direction="inline" gap="small-300" alignItems="center">
            <s-text>{f.name}</s-text>
            <s-button
              variant="tertiary"
              icon="delete"
              accessibilityLabel={`Remove attachment ${f.name}`}
              disabled={busy}
              onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
            />
          </s-stack>
        ))}
      </s-stack>
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
      {manageRepliesHref ? <s-link href={manageRepliesHref}>Manage saved replies</s-link> : null}
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
    </s-stack>
  );
}
