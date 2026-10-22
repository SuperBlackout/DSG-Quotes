import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { AccountPage } from './AccountPage.jsx';

export default async () => {
  render(<AccountPage />, document.body);
};
