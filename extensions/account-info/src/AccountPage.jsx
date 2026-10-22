import { useEffect, useMemo, useReducer } from 'preact/hooks';
import { createApi, shopifyToken, formatAddress, formatAsOf, formatMoney } from '@dsg/account-client';
import { createAccountStore } from './state.ts';

function useStore() {
  const store = useMemo(() => createAccountStore(createApi({ getToken: shopifyToken })), []);
  const [, bump] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    const unsub = store.subscribe(bump);
    store.load();
    return unsub;
  }, [store]);
  return [store, store.getState()];
}

function Field({ label, children }) {
  return (
    <s-stack gap="small-300">
      <s-text color="subdued">{label}</s-text>
      {children}
    </s-stack>
  );
}

function Address({ label, address }) {
  const lines = formatAddress(address);
  return (
    <Field label={label}>
      {lines.length ? lines.map((l) => <s-text key={l}>{l}</s-text>) : <s-text color="subdued">Not set</s-text>}
      {address && address.phone ? <s-text color="subdued">{address.phone}</s-text> : null}
    </Field>
  );
}

export function AccountPage() {
  const [store, st] = useStore();

  if (st.status === 'loading') {
    return (
      <s-page heading="Account">
        <s-stack alignItems="center" padding="large"><s-spinner accessibilityLabel="Loading account" /></s-stack>
      </s-page>
    );
  }

  if (st.status === 'error') {
    const k = st.error.kind;
    const heading = k === 'not_linked' ? 'Account not linked' : k === 'unavailable' ? 'Temporarily unavailable' : k === 'rate_limited' ? 'Too many requests' : 'Could not load account';
    return (
      <s-page heading="Account">
        <s-banner tone={k === 'not_linked' ? 'warning' : 'critical'} heading={heading}>
          <s-text>{st.error.message}</s-text>
          {k === 'not_linked' ? <s-text> Contact your account manager to link your company to billing.</s-text> : null}
        </s-banner>
        {k !== 'not_linked' ? <s-button onClick={() => store.load()}>Try again</s-button> : null}
      </s-page>
    );
  }

  const a = st.account;
  const cur = a.currency ?? 'USD';
  return (
    <s-page heading="Account">
      <s-stack gap="base">
        <s-stack gap="small-300">
          <s-heading>{a.companyName}</s-heading>
          <s-text color="subdued">Customer no. {a.customerNumber}</s-text>
        </s-stack>

        <s-section heading="Billing terms">
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
            <Field label="Payment terms"><s-text>{a.paymentTerms ?? '—'}</s-text></Field>
            <Field label="Credit limit"><s-text>{a.creditLimit && a.creditLimit !== '0.00' ? formatMoney(a.creditLimit, cur) : a.zohoAsOf ? 'Not set' : '—'}</s-text></Field>
            <Field label="Currency"><s-text>{a.currency ?? '—'}</s-text></Field>
          </s-grid>
          <s-text color="subdued">{a.zohoAsOf ? `Billing details as of ${formatAsOf(a.zohoAsOf)}.` : 'Billing details are not available yet.'}</s-text>
        </s-section>

        <s-section heading="Locations">
          {a.locations.length === 0 ? (
            <s-text color="subdued">No locations on file.</s-text>
          ) : (
            <s-stack gap="base">
              {a.locations.map((l) => (
                <s-box key={l.id} padding="base" border="base" borderRadius="base">
                  <s-stack gap="base">
                    <s-heading>{l.name}</s-heading>
                    <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
                      <Address label="Billing address" address={l.billingAddress} />
                      <Address label="Shipping address" address={l.shippingAddress} />
                    </s-grid>
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          )}
        </s-section>

        <s-section heading="Contacts">
          {a.contacts.length === 0 ? (
            <s-text color="subdued">No contacts on file.</s-text>
          ) : (
            <s-stack gap="base">
              {a.contacts.map((c) => (
                <s-stack key={`${c.email ?? c.name}`} gap="small-300">
                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    <s-text type="strong">{c.name}</s-text>
                    {c.isMainContact ? <s-badge>Main contact</s-badge> : null}
                  </s-stack>
                  {c.title ? <s-text color="subdued">{c.title}</s-text> : null}
                  {c.email ? <s-text>{c.email}</s-text> : null}
                  {c.roles.length ? <s-text color="subdued">{c.roles.join(', ')}</s-text> : null}
                </s-stack>
              ))}
            </s-stack>
          )}
          <s-text color="subdued">To change company details or contacts, contact your account manager.</s-text>
        </s-section>
      </s-stack>
    </s-page>
  );
}
