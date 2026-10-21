import { useEffect, useState, type ReactNode } from "react";
import type { QuoteStatus } from "shared";
import { ApiError } from "../lib/api-client";
import { STATUS_LABEL, STATUS_TONE, waitingLabel, waitingSeverity } from "../lib/editor-state";

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}

export function StatusBadge({ status }: { status: QuoteStatus }) {
  return <s-badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</s-badge>;
}

export function ErrorBanner({ message, onDismiss }: { message: string | null | undefined; onDismiss?: () => void }) {
  if (!message) return null;
  return (
    <s-banner tone="critical" dismissible={!!onDismiss} onDismiss={onDismiss}>
      {message}
    </s-banner>
  );
}

export function LoadingPage({ heading }: { heading: string }) {
  return (
    <s-page heading={heading}>
      <s-section>
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-spinner accessibilityLabel="Loading" />
          <s-text>Loading</s-text>
        </s-stack>
      </s-section>
    </s-page>
  );
}

/** Re-renders every `intervalMs` so waiting timers stay current. */
export function useNow(intervalMs = 30000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** "3h 10m" with warning/critical colouring after 1h / 4h. */
export function WaitingTimer({ since, now }: { since: string | null | undefined; now: Date }): ReactNode {
  const label = waitingLabel(since, now);
  if (!label) return <s-text color="subdued">n/a</s-text>;
  const sev = waitingSeverity(since, now);
  return sev === "none" ? (
    <s-text>{label}</s-text>
  ) : (
    <s-badge tone={sev === "critical" ? "critical" : "warning"}>{label}</s-badge>
  );
}
