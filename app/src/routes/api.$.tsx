import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

// The admin screens call the quotes API at "/api/..." on their own origin (docs/openapi.yaml, server "/api").
// The API is a separate service, so this route forwards each request to it unchanged. The browser already
// sends the App Bridge session token in Authorization; nothing is added or stripped here except hop-by-hop headers.
const API_ORIGIN = (process.env.QUOTES_API_ORIGIN || "").replace(/\/$/, "");

const PASS_REQUEST_HEADERS = ["authorization", "content-type", "accept", "accept-language", "if-none-match"];
const DROP_RESPONSE_HEADERS = ["content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie"];

async function forward(request: Request): Promise<Response> {
  if (!API_ORIGIN) {
    return Response.json({ code: "NOT_CONFIGURED", message: "QUOTES_API_ORIGIN is not set" }, { status: 503 });
  }
  const url = new URL(request.url);
  const headers = new Headers();
  for (const name of PASS_REQUEST_HEADERS) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(`${API_ORIGIN}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: "manual",
    });
  } catch {
    return Response.json({ code: "UPSTREAM_UNAVAILABLE", message: "The quotes service could not be reached" }, { status: 502 });
  }
  const out = new Headers(upstream.headers);
  for (const name of DROP_RESPONSE_HEADERS) out.delete(name);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export const loader = ({ request }: LoaderFunctionArgs) => forward(request);
export const action = ({ request }: ActionFunctionArgs) => forward(request);
