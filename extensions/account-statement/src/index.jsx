import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { StatementPage } from './StatementPage.jsx';

export default async () => {
  render(<StatementPage />, document.body);
};
