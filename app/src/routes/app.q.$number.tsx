/**
 * /app/q/10482 -> /app/quotes/<id>. Used by the draft-order "Open quote Q-#####" action, which only knows the
 * quote number (from the `quote:Q-#####` tag). Resolves via the inbox search (`q`) on the `all` tab.
 */
import type { ClientLoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { getBrowserClients } from "../lib/browser-client";
import { parseQuoteNumber } from "../lib/editor-state";
import { ErrorBanner, LoadingPage, errorMessage } from "../components/common";

export const clientLoader = async ({ params }: ClientLoaderFunctionArgs) => {
  const n = parseQuoteNumber(params["number"] ?? "");
  if (n === null) return { error: "That is not a valid quote number." };
  try {
    const page = await getBrowserClients().staff.listQuotes({ tab: "all", q: `Q-${n}`, limit: 10 });
    const hit = page.items.find((i) => i.number === n);
    if (hit) return redirect(`/app/quotes/${encodeURIComponent(hit.id)}`);
    return { error: `Quote Q-${n} was not found.` };
  } catch (e) {
    return { error: errorMessage(e) };
  }
};
clientLoader.hydrate = true as const;

export function HydrateFallback() {
  return <LoadingPage heading="Opening quote" />;
}

export default function OpenByNumber() {
  const data = useLoaderData<typeof clientLoader>();
  return (
    <s-page heading="Open quote">
      <s-link slot="breadcrumb-actions" href="/app">
        Inbox
      </s-link>
      <ErrorBanner message={data && "error" in data ? data.error : null} />
    </s-page>
  );
}
