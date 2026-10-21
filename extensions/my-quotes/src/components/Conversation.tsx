// Conversation panel: customer-visible messages (internal notes are never returned by the API),
// composer with attachments (signed upload URL, then POST message).
import { useEffect, useState } from "preact/hooks";
import { api } from "../api/instance";
import type { Attachment, CustomerMessage, CustomerQuote } from "../api/types";
import { formatDateTime } from "../lib/format";
import { errorMessage } from "../ui/common";
import { filesOf, valueOf } from "../ui/events";
import { toApiError, useAction } from "../ui/hooks";

const POLL_MS = 30_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024; // keep in step with the bucket policy (docs/SETUP.md section 7)

export function Conversation({ quote }: { quote: CustomerQuote }) {
  const [messages, setMessages] = useState<CustomerMessage[]>(quote.messages);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | undefined>(undefined);
  const action = useAction();

  // The quote payload carries the latest page; take it whenever the quote is refreshed.
  useEffect(() => setMessages(quote.messages), [quote.messages]);

  // New replies from sales (also arriving by email/SMS) show up without a manual reload.
  useEffect(() => {
    const timer = setInterval(() => {
      api()
        .listMessages(quote.id, { limit: 100 })
        .then((page) => setMessages(page.items))
        .catch(() => undefined); // a missed poll is not worth an error banner
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [quote.id]);

  const rep = quote.assignedRepName?.split(" ")[0];
  const closed = quote.status === "ARCHIVED";

  function addFiles(list: File[]) {
    const tooBig = list.find((f) => f.size > MAX_FILE_BYTES);
    if (tooBig) {
      setFileError(`${tooBig.name} is larger than 20 MB.`);
      return;
    }
    setFileError(undefined);
    setFiles((cur) => [...cur, ...list]);
  }

  async function send() {
    const body = text.trim();
    if (!body && files.length === 0) return;
    const posted = await action.run("send", async () => {
      const attachments: Attachment[] = [];
      for (const f of files) attachments.push(await api().uploadAttachment(quote.id, f));
      return api().postMessage(quote.id, { body: body || "(attachment)", attachments });
    });
    if (posted) {
      setMessages((m) => [...m, posted]);
      setText("");
      setFiles([]);
    }
  }

  return (
    <s-section heading="Conversation" accessibilityLabel="Quote conversation">
      <s-stack direction="block" gap="base">
        <s-text color="subdued" type="small">
          {rep ? `You, ${rep}, Sales team` : "You and the DSG sales team"}
        </s-text>

        <s-stack direction="block" gap="base">
          {messages.length === 0 ? <s-text color="subdued">No messages yet. Ask a question below.</s-text> : null}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
        </s-stack>

        <s-divider />

        {closed ? null : (
          <s-stack direction="block" gap="small">
            {action.error ? <s-banner tone="critical">{errorMessage(toApiError(action.error))}</s-banner> : null}
            <s-text-area
              label="Message"
              labelAccessibilityVisibility="exclusive"
              rows={3}
              placeholder="Ask a question or explain a change…"
              value={text}
              onInput={(e: Event) => setText(valueOf(e))}
            />
            <s-drop-zone
              label="Attach a file"
              accessibilityLabel="Attach a file"
              multiple
              error={fileError}
              onInput={(e: Event) => addFiles(filesOf(e))}
            />
            {files.map((f, i) => (
              <s-stack key={`${f.name}-${i}`} direction="inline" gap="small" alignItems="center" justifyContent="space-between">
                <s-text>{f.name}</s-text>
                <s-button
                  accessibilityLabel={`Remove ${f.name}`}
                  onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}
                >
                  Remove
                </s-button>
              </s-stack>
            ))}
            <s-stack direction="inline" gap="small" alignItems="center" justifyContent="space-between">
              <s-text color="subdued" type="small">
                {rep ?? "Sales"} gets this by email + text
              </s-text>
              <s-button
                variant="primary"
                loading={action.busy === "send"}
                disabled={!text.trim() && files.length === 0}
                onClick={() => void send()}
              >
                Send
              </s-button>
            </s-stack>
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}

function MessageBubble({ message: m }: { message: CustomerMessage }) {
  if (m.authorType === "SYSTEM") {
    return (
      <s-text color="subdued" type="small">
        {formatDateTime(m.createdAt)} · {m.body}
      </s-text>
    );
  }
  const mine = m.authorType === "CUSTOMER";
  const unread = !mine && !m.readAt;
  const via = m.channel === "SMS" ? " · by text" : m.channel === "EMAIL" ? " · by email" : "";
  return (
    <s-stack direction="block" alignItems={mine ? "end" : "start"}>
      <s-box
        background={mine ? "subdued" : "base"}
        border={mine ? "none" : "base"}
        borderRadius="base"
        padding="small"
        maxInlineSize="90%"
      >
        <s-stack direction="block" gap="small-200">
          {unread ? <s-badge tone="auto">New</s-badge> : null}
          <s-paragraph>{m.body}</s-paragraph>
          {m.attachments.map((a) => (
            <s-link key={a.url} href={a.url} target="_blank">
              {a.name} ({formatSize(a.size)})
            </s-link>
          ))}
          <s-text color="subdued" type="small">
            {mine ? "You" : (m.authorName ?? "DSG")}
            {via} · {formatDateTime(m.createdAt)}
          </s-text>
        </s-stack>
      </s-box>
    </s-stack>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
