import { HttpError, type AccountContact, type AccountLocation, type AccountAddress } from '@dsg/contracts';
import type { ShopifyAdmin } from './shopifyAdmin.js';

/**
 * Company profile for the Account page. Read-only Admin GraphQL (needs read_companies + read_customers).
 * Unverified against the live schema until `pnpm -F api graphql:validate` has run with the 2026-07 schema.
 */
export const ACCOUNT_INFO_QUERY = `query AccountInfo($id: ID!) {
  company(id: $id) {
    id
    name
    externalId
    locations(first: 50) {
      nodes {
        id
        name
        billingAddress { address1 address2 city zoneCode zip countryCode phone }
        shippingAddress { address1 address2 city zoneCode zip countryCode phone }
      }
    }
    contacts(first: 50) {
      nodes {
        title
        isMainContact
        customer { displayName email }
        roleAssignments(first: 10) { nodes { role { name } } }
      }
    }
  }
}`;

interface RawAddress { address1?: string | null; address2?: string | null; city?: string | null; zoneCode?: string | null; zip?: string | null; countryCode?: string | null; phone?: string | null }
interface RawData {
  company: null | {
    id: string; name: string; externalId: string | null;
    locations?: { nodes?: Array<{ id: string; name: string; billingAddress?: RawAddress | null; shippingAddress?: RawAddress | null }> };
    contacts?: { nodes?: Array<{
      title?: string | null; isMainContact?: boolean | null;
      customer?: { displayName?: string | null; email?: string | null } | null;
      roleAssignments?: { nodes?: Array<{ role?: { name?: string | null } | null }> };
    }> };
  };
}

const addr = (a: RawAddress | null | undefined): AccountAddress | null => a ? {
  address1: a.address1 ?? null, address2: a.address2 ?? null, city: a.city ?? null,
  province: a.zoneCode ?? null, zip: a.zip ?? null, country: a.countryCode ?? null, phone: a.phone ?? null,
} : null;

export interface CompanyProfile { name: string; externalId: string | null; locations: AccountLocation[]; contacts: AccountContact[] }

/** Reads the company profile for an already-authorised company id (the id comes from the verified buyer, never the client). */
export async function readCompanyProfile(admin: ShopifyAdmin, companyId: string): Promise<CompanyProfile> {
  const data = await admin.graphql<RawData>(ACCOUNT_INFO_QUERY, { id: companyId });
  const c = data?.company;
  if (!c) throw new HttpError(503, 'Account lookup temporarily unavailable');
  return {
    name: c.name,
    externalId: c.externalId ?? null,
    locations: (c.locations?.nodes ?? []).map(l => ({ id: l.id, name: l.name, billingAddress: addr(l.billingAddress), shippingAddress: addr(l.shippingAddress) })),
    contacts: (c.contacts?.nodes ?? []).map(k => ({
      name: k.customer?.displayName?.trim() || k.customer?.email || 'Unnamed contact',
      email: k.customer?.email ?? null,
      title: k.title ?? null,
      isMainContact: !!k.isMainContact,
      roles: [...new Set((k.roleAssignments?.nodes ?? []).map(n => n?.role?.name).filter((r): r is string => typeof r === 'string'))],
    })),
  };
}
