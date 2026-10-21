// Which recoverable API errors the UI treats specially (docs/openapi.yaml Error.code).
import type { ApiError } from "../api/client";

type CodeOnly = Pick<ApiError, "code">;

/** 409 from /checkout: the quote is not ACCEPTED any more or has expired. Offer "Ask for a new quote". */
export function isNotPurchasableError(e: CodeOnly | undefined): boolean {
  return e?.code === "NOT_PURCHASABLE";
}

/** 409 from /accept: sales sent a newer version than the one the customer saw. */
export function isVersionMismatchError(e: CodeOnly | undefined): boolean {
  return e?.code === "VERSION_MISMATCH";
}

/**
 * No HTTP response at all: offline, DNS, or a CORS rejection. The extension runs with a null origin,
 * so a backend CORS misconfiguration looks exactly like this and is worth a retry button, not a crash.
 */
export function isNetworkError(e: CodeOnly | undefined): boolean {
  return e?.code === "NETWORK";
}

export const ASK_NEW_QUOTE_LABEL = "Ask for a new quote";
export const REVIEW_NEW_VERSION_LABEL = "Review the new version";

/** "Sales sent v3 while you were looking at this quote. Review it, then accept again." */
export function versionMismatchMessage(e: Pick<ApiError, "details">): string {
  const v = e.details?.["currentVersion"];
  const which = typeof v === "number" ? `version ${v}` : "a newer version";
  return `Sales sent ${which} while you were looking at this quote. Review it, then accept again.`;
}
