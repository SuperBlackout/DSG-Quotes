import { useCallback, useEffect, useState } from "react";
import { getBrowserClients } from "../lib/browser-client";
import type { QuoteNotifications as Data } from "../lib/api-client";
import { ErrorBanner, errorMessage } from "./common";

const fmt = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

const STATUS_LABEL: Record<string, string> = {
  SENT: "Sent",
  FAILED: "Failed",
  SKIPPED_OPTED_OUT: "Skipped (replied STOP)",
  SKIPPED_NO_OPT_IN: "Skipped (no text opt-in)",
  SKIPPED_SMS_DISABLED: "Skipped (texting off)",
  SKIPPED_QUIET_HOURS: "Held for quiet hours",
  OPTED_OUT: "Replied STOP",
  WELCOME_SENT: "Welcome text sent",
  WELCOME_FAILED: "Welcome text failed",
};

/** "Who gets alerts for this quote": the resolved recipients, extra people for this quote only, and a short send log. */
export function QuoteNotifications({ quoteId, refreshKey }: { quoteId: string; refreshKey: number }) {
  const { staff: api } = getBrowserClients();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.getNotifications(quoteId));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [api, quoteId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
      if (done) setNote(done);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const addEmail = () => {
    const address = email.trim();
    if (!address) return;
    void run(async () => {
      await api.addNotificationRecipient(quoteId, { kind: "EMAIL", address, ...(name.trim() ? { name: name.trim() } : {}) });
      setEmail("");
      setName("");
    }, "Added. They will get customer alerts for this quote.");
  };
  const addPhone = () => {
    const address = phone.trim();
    if (!address) return;
    void run(async () => {
      await api.addNotificationRecipient(quoteId, { kind: "SMS", address, ...(name.trim() ? { name: name.trim() } : {}) });
      setPhone("");
      setName("");
    }, "Confirmation text queued. Texts start once they reply YES.");
  };

  return (
    <s-stack gap="base">
      <s-text color="subdued">Customer alerts for this quote go to the people below. Texts only go to numbers that opted in.</s-text>
      {data === null ? <s-text color="subdued">Loading…</s-text> : null}
      {data ? (
        <s-stack gap="small-300">
          {data.recipients.map((r, i) => (
            <s-stack key={`${r.who}-${i}`} direction="inline" gap="small" alignItems="center">
              <s-badge tone={r.group === "customer" ? "info" : "neutral"}>{r.who}</s-badge>
              <s-text>
                {r.name}
                {r.email ? ` · ${r.email}${r.emailOn ? "" : " (email off)"}` : " · no email"}
                {r.texting === "on" ? ` · text ${r.phone}` : r.texting === "stopped" ? " · text stopped (STOP)" : " · no texts"}
                {r.cc ? ` · cc ${r.cc}` : ""}
              </s-text>
            </s-stack>
          ))}
          {data.extras.map((x) => (
            <s-stack key={x.id} direction="inline" gap="small" alignItems="center">
              <s-badge tone={x.status === "ACTIVE" ? "success" : x.status === "PENDING" ? "warning" : "critical"}>
                {x.status === "ACTIVE" ? "Added" : x.status === "PENDING" ? "Waiting for YES" : "Replied STOP"}
              </s-badge>
              <s-text>
                {x.name ? `${x.name} · ` : ""}
                {x.kind === "EMAIL" ? x.address : `text ${x.address}`}
                {x.addedBy ? ` · added by ${x.addedBy}` : ""}
              </s-text>
              {x.status === "PENDING" ? (
                <s-button variant="tertiary" disabled={busy} onClick={() => void run(() => api.resendNotificationOptIn(quoteId, x.id), "Confirmation text queued again.")}>
                  Resend text
                </s-button>
              ) : null}
              <s-button variant="tertiary" tone="critical" disabled={busy} accessibilityLabel={`Remove ${x.address}`} onClick={() => void run(() => api.removeNotificationRecipient(quoteId, x.id))}>
                Remove
              </s-button>
            </s-stack>
          ))}
        </s-stack>
      ) : null}

      <s-divider />
      <s-text type="strong">Add someone for this quote only</s-text>
      <s-text-field label="Name (optional)" value={name} onInput={(e) => { const v = e.currentTarget.value; setName(v); }} />
      <s-stack direction="inline" gap="small" alignItems="end">
        <s-email-field label="Email address" value={email} onInput={(e) => { const v = e.currentTarget.value; setEmail(v); }} />
        <s-button disabled={busy || email.trim() === ""} onClick={addEmail}>
          Add email
        </s-button>
      </s-stack>
      <s-stack direction="inline" gap="small" alignItems="end">
        <s-text-field label="Mobile number" placeholder="(555) 123-4567" value={phone} onInput={(e) => { const v = e.currentTarget.value; setPhone(v); }} />
        <s-button disabled={busy || phone.trim() === ""} onClick={addPhone}>
          Send confirmation text
        </s-button>
      </s-stack>
      <s-text color="subdued">A person must reply YES to the confirmation text before they get any texts. They can reply STOP at any time.</s-text>
      {note ? <s-banner tone="success">{note}</s-banner> : null}
      <ErrorBanner message={error} onDismiss={() => setError(null)} />

      <s-divider />
      <s-text type="strong">Recent sends</s-text>
      {data && data.log.length === 0 ? <s-text color="subdued">Nothing sent yet.</s-text> : null}
      <s-stack gap="small-500">
        {(data?.log ?? []).map((l, i) => (
          <s-text key={`${l.at}-${i}`} color={l.status === "SENT" ? undefined : "subdued"}>
            {fmt(l.at)} · {l.channel === "SMS" ? "Text" : "Email"} to {l.to} · {STATUS_LABEL[l.status] ?? l.status}
          </s-text>
        ))}
      </s-stack>
    </s-stack>
  );
}
