// Entry point for the customer-account.page.render target (see shopify.extension.toml).
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { App } from "./app";

export default async () => {
  render(<App />, document.body);
};
