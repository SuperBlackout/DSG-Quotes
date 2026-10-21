import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

// Shopify opens the app at "/" with ?shop=...&host=...&id_token=... . The screens live under /app, so forward the
// whole query string there (same behaviour as the Shopify React Router template).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  throw redirect(`/app${url.search}`);
};
