import { useEffect, useState } from "react";
import type { StaffCustomer } from "../lib/api-client";
import { getBrowserClients } from "../lib/browser-client";
import { CUSTOMER_SEARCH_DEBOUNCE_MS, MIN_CUSTOMER_SEARCH, canSearchCustomers } from "../lib/staff";
import { ErrorBanner, errorMessage } from "./common";

/**
 * "Create quote for customer": debounced customer search (`GET /s/customers?q=`, 2+ characters), pick the customer's
 * company location, name the quote, then `POST /s/quotes`.
 */
export function CreateQuoteModal({ onCreated }: { onCreated: (id: string) => void }) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<StaffCustomer[]>([]);
  const [searching, setSearching] = useState(false);
  const [customer, setCustomer] = useState<StaffCustomer | null>(null);
  const [locationId, setLocationId] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (customer || !canSearchCustomers(search)) {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      getBrowserClients()
        .staff.searchCustomers(search)
        .then((r) => {
          if (!cancelled) setResults(r.items);
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(errorMessage(e));
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, CUSTOMER_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search, customer]);

  const choose = (c: StaffCustomer) => {
    setCustomer(c);
    setLocationId(c.locations?.length === 1 ? (c.locations[0]?.companyLocationId ?? "") : "");
    setResults([]);
  };

  const reset = () => {
    setCustomer(null);
    setLocationId("");
    setSearch("");
  };

  const locations = customer?.locations ?? [];
  const needsLocation = locations.length > 0;

  const submit = async () => {
    setError(null);
    if (!customer) {
      setError("Search for and choose a customer first.");
      return;
    }
    if (needsLocation && !locationId) {
      setError("Choose the company location this quote is for.");
      return;
    }
    if (!title.trim()) {
      setError("Give the quote a title.");
      return;
    }
    setBusy(true);
    try {
      const q = await getBrowserClients().staff.createQuote({
        customerId: customer.customerId,
        ...(locationId ? { companyLocationId: locationId } : {}),
        title: title.trim(),
        submit: false,
      });
      onCreated(q.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <s-modal id="create-quote-modal" heading="Create quote for customer">
      <s-stack gap="base">
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
        {customer ? (
          <s-box padding="small" border="base" borderRadius="base">
            <s-stack direction="inline" justifyContent="space-between" alignItems="center">
              <s-stack gap="small-500">
                <s-text type="strong">{customer.name}</s-text>
                <s-text color="subdued">{[customer.companyName, customer.email].filter(Boolean).join(" · ")}</s-text>
              </s-stack>
              <s-button variant="tertiary" onClick={reset}>
                Change
              </s-button>
            </s-stack>
          </s-box>
        ) : (
          <s-stack gap="small">
            <s-search-field
              label="Find customer"
              details={`Name, email, phone or company (${MIN_CUSTOMER_SEARCH}+ characters)`}
              value={search}
              onInput={(e) => setSearch(e.currentTarget.value)}
            />
            {searching ? <s-text color="subdued">Searching…</s-text> : null}
            {!searching && canSearchCustomers(search) && results.length === 0 ? <s-text color="subdued">No customers found.</s-text> : null}
            {results.map((c) => (
              <s-clickable key={c.customerId} onClick={() => choose(c)} accessibilityLabel={`Choose ${c.name}`}>
                <s-box padding="small" border="base" borderRadius="base">
                  <s-stack gap="small-500">
                    <s-text type="strong">{c.name}</s-text>
                    <s-text color="subdued">{[c.companyName, c.email, c.phone].filter(Boolean).join(" · ")}</s-text>
                  </s-stack>
                </s-box>
              </s-clickable>
            ))}
          </s-stack>
        )}
        {customer && needsLocation ? (
          <s-select label="Company location" value={locationId} onChange={(e) => setLocationId(e.currentTarget.value)}>
            <s-option value="">Choose…</s-option>
            {locations.map((l) => (
              <s-option key={l.companyLocationId} value={l.companyLocationId}>
                {l.name}
              </s-option>
            ))}
          </s-select>
        ) : null}
        <s-text-field label="Quote title" value={title} onInput={(e) => setTitle(e.currentTarget.value)} />
      </s-stack>
      <s-button slot="primary-action" variant="primary" loading={busy} onClick={submit}>
        Create
      </s-button>
      <s-button slot="secondary-actions" commandFor="create-quote-modal" command="--hide">
        Cancel
      </s-button>
    </s-modal>
  );
}
