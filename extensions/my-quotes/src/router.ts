// In-extension routing. A full-page extension owns exactly one URL, so list / detail / settings are
// sub-routes resolved with the Navigation API (`extension://<path>`), per Shopify's "Full page" docs.
//
//   extension://                 -> quote list      (screen 3)
//   extension://q/<quoteId>      -> quote detail    (screen 4)
//   extension://notifications    -> settings        (screen 5)
//
// The detail prefix is "q/" (not "quotes/") so it can never collide with the extension handle
// "my-quotes" that appears earlier in the real page URL.

export type Route =
  | { name: "list" }
  | { name: "detail"; id: string }
  | { name: "notifications" };

export function routeHref(route: Route): string {
  switch (route.name) {
    case "list":
      return "extension://";
    case "detail":
      return `extension://q/${encodeURIComponent(route.id)}`;
    case "notifications":
      return "extension://notifications";
  }
}

/** Parse the URL of `navigation.currentEntry`. Unknown paths fall back to the list. */
export function parseRoute(url: string | null | undefined): Route {
  if (!url) return { name: "list" };
  // currentEntry.url is a real https URL; `extension://...` (our own hrefs) has no host to strip.
  let path = url.split(/[?#]/)[0] ?? "";
  if (/^https?:\/\//i.test(path)) path = path.replace(/^https?:\/\/[^/]*/i, "");
  else path = path.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const segments = path.split("/").filter(Boolean);

  const last = segments[segments.length - 1];
  if (last === "notifications") return { name: "notifications" };

  const prev = segments[segments.length - 2];
  if (prev === "q" && last) {
    try {
      return { name: "detail", id: decodeURIComponent(last) };
    } catch {
      return { name: "list" };
    }
  }
  return { name: "list" };
}
