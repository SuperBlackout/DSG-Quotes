import type { ComponentChildren } from "preact";
import type { ApiError } from "../api/client";
import type { CustomerQuoteSummary } from "../api/types";
import { statusBadgeTone, statusLabel } from "../lib/status";
import { routeHref, type Route } from "../router";
import { go } from "./hooks";

/** Container-query breakpoints used across screens. */
export const WIDE_700 = "@container (inline-size > 700px)";
export const WIDE_900 = "@container (inline-size > 900px)";

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <s-stack direction="inline" gap="small" alignItems="center" justifyContent="center" padding="large">
      <s-spinner accessibilityLabel={label} />
      <s-text color="subdued">{label}…</s-text>
    </s-stack>
  );
}

/** Friendlier wording for the stable API error codes (docs/openapi.yaml Error.code). */
export function errorMessage(error: ApiError): string {
  switch (error.code) {
    case "UNAUTHENTICATED":
      return "Your session expired. Reload the page and sign in again.";
    case "FORBIDDEN":
    case "NOT_FOUND":
      return "We could not find that quote for your company.";
    case "NETWORK":
      return "We could not reach DSG Quotes. Check your connection and try again.";
    case "RATE_LIMITED":
      return "Too many requests. Wait a moment and try again.";
    case "VERSION_MISMATCH":
      return "Sales just sent a newer version of this quote. Review the update before accepting.";
    default:
      // INVALID_TRANSITION, NOT_PURCHASABLE, NOT_EDITABLE, VALIDATION_FAILED ...: the API message is
      // written for customers (ISSUE-3: "shows the API message").
      return error.message;
  }
}

export function ErrorBanner({
  error,
  onRetry,
  children,
}: {
  error: ApiError;
  onRetry?: () => void;
  children?: ComponentChildren;
}) {
  return (
    <s-banner tone="critical" heading="Something went wrong">
      <s-stack direction="block" gap="small">
        <s-text>{errorMessage(error)}</s-text>
        {onRetry ? (
          <s-stack direction="inline">
            <s-button onClick={onRetry}>Try again</s-button>
          </s-stack>
        ) : null}
        {children}
      </s-stack>
    </s-banner>
  );
}

/** In-extension link: real href for semantics, Navigation API on click for reliability. */
export function NavLink({
  route,
  children,
  slot,
}: {
  route: Route;
  children: ComponentChildren;
  slot?: Lowercase<string>;
}) {
  return (
    <s-link
      slot={slot}
      href={routeHref(route)}
      onClick={(e: Event) => {
        e.preventDefault?.();
        go(route);
      }}
    >
      {children}
    </s-link>
  );
}

export function StatusBadge({ quote }: { quote: Pick<CustomerQuoteSummary, "status" | "currentVersion"> }) {
  return <s-badge tone={statusBadgeTone(quote.status)}>{statusLabel(quote)}</s-badge>;
}
