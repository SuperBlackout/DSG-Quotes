import { useErrorBoundary } from "preact/hooks";
import { Notifications } from "./routes/Notifications";
import { QuoteDetail } from "./routes/QuoteDetail";
import { QuoteList } from "./routes/QuoteList";
import { NavLink } from "./ui/common";
import { useRoute } from "./ui/hooks";

export function App() {
  const route = useRoute();
  const [crash, resetCrash] = useErrorBoundary();

  if (crash) {
    return (
      <s-page heading="My Quotes">
        <s-banner tone="critical" heading="This page hit a problem">
          <s-stack direction="block" gap="small">
            <s-text>Reload the page. If it keeps happening, tell your DSG rep.</s-text>
            <s-stack direction="inline" gap="small">
              <s-button onClick={resetCrash}>Try again</s-button>
              <NavLink route={{ name: "list" }}>Back to My Quotes</NavLink>
            </s-stack>
          </s-stack>
        </s-banner>
      </s-page>
    );
  }

  switch (route.name) {
    case "detail":
      // key: switching quotes must not reuse the previous quote's local state
      return <QuoteDetail key={route.id} id={route.id} />;
    case "notifications":
      return <Notifications />;
    case "list":
      return <QuoteList />;
  }
}
