import { jwtVerify, errors } from 'jose';
import { HttpError, type Buyer, type BuyerResolver } from '@dsg/contracts';
import type { AccountMapRepo } from '@dsg/statement';
import type { ShopifyAdmin } from './shopifyAdmin.js';

export const RESOLVE_BUYER_QUERY =
  'query ResolveBuyer($id: ID!) { customer(id: $id) { id companyContactProfiles { id company { id name externalId } roleAssignments(first: 10) { nodes { role { name } companyLocation { id name externalId } } } } } }';

export interface ShopifyBuyerResolverOpts {
  apiSecret: string;            // SHOPIFY_API_SECRET
  apiKey: string;               // SHOPIFY_API_KEY (expected aud)
  allowedShops: string[];       // e.g. ['dsg.myshopify.com'] (dest must be https://<one of these>)
  admin: ShopifyAdmin;
  accountMap: Pick<AccountMapRepo, 'getByShopifyCompanyId'>;
  allowedRoles?: string[];      // default ['Location admin']
  cacheTtlMs?: number;          // default 60_000
  now?: () => number;
  log?: (event: string, fields: Record<string, string>) => void;
}

interface ShopifyCustomerData {
  customer: null | {
    id: string;
    companyContactProfiles: Array<{
      id: string;
      company: { id: string; name: string; externalId: string | null };
      roleAssignments: { nodes: Array<{ role: { name: string } }> };
    }>;
  };
}
type Lookup = { companyId: string; companyExternalId: string | null; roles: string[] } | { denied: true };

const CUSTOMER_GID = /^gid:\/\/shopify\/Customer\/\d+$/;
/** Lower-case, no scheme, no trailing slash, so 'https://x.myshopify.com/' and 'x.myshopify.com' compare equal. */
const normDest = (v: string) => v.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
const deny401 = () => new HttpError(401, 'Unauthorized');
const deny403 = () => new HttpError(403, 'Forbidden');

export class ShopifyBuyerResolver implements BuyerResolver {
  private cache = new Map<string, { exp: number; v: Lookup }>();
  private roles: string[];
  private ttl: number;
  private now: () => number;
  private dests: Set<string>;
  private secret: Uint8Array;
  constructor(private o: ShopifyBuyerResolverOpts) {
    if (!o.apiSecret || !o.apiKey) throw new Error('apiSecret and apiKey required');
    this.roles = o.allowedRoles ?? ['Location admin'];
    this.ttl = o.cacheTtlMs ?? 60_000;
    this.now = o.now ?? Date.now;
    this.dests = new Set(o.allowedShops.map(s => normDest(s)));
    this.secret = new TextEncoder().encode(o.apiSecret);
  }

  async resolve(authorizationHeader: string | undefined): Promise<Buyer> {
    const customerGid = await this.verify(authorizationHeader);
    const look = await this.lookup(customerGid);
    if ('denied' in look) throw deny403();
    const row = await this.o.accountMap.getByShopifyCompanyId(look.companyId);
    if (!row) { this.log('unmapped_company', { company: look.companyId }); throw deny403(); }
    if (look.companyExternalId !== row.customerNumber) {
      this.log('external_id_mismatch', { company: look.companyId });
      throw deny403();
    }
    const role = this.roles.find(r => look.roles.includes(r))!;
    return {
      shopifyCustomerId: customerGid, shopifyCompanyId: look.companyId, role,
      zohoCustomerId: row.zohoCustomerId, customerNumber: row.customerNumber,
    };
  }

  /** Verifies the session token (never cached). Returns the customer GID. */
  private async verify(header: string | undefined): Promise<string> {
    const m = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header ?? '');
    if (!m) { this.log('token_rejected', { reason: 'no_bearer_header' }); throw deny401(); }
    try {
      const { payload } = await jwtVerify(m[1]!, this.secret, {
        algorithms: ['HS256'],
        audience: this.o.apiKey,
        clockTolerance: 10,
        currentDate: new Date(this.now()),
        requiredClaims: ['exp', 'sub', 'aud', 'dest'],
      });
      const dest = typeof payload.dest === 'string' ? normDest(payload.dest) : '';
      if (!this.dests.has(dest)) {
        // The shop address is not a secret; logging it shows which allow-list entry is missing.
        this.log('token_rejected', { reason: 'dest', dest: dest.slice(0, 100) });
        throw new Error('dest');
      }
      if (typeof payload.sub !== 'string' || !CUSTOMER_GID.test(payload.sub)) throw new Error('sub');
      return payload.sub;
    } catch (e) {
      if (!(e instanceof errors.JOSEError) && !(e instanceof Error)) throw e;
      // Reason only (error code/name); never the token or its claims' values.
      this.log('token_rejected', { reason: (e as { code?: string }).code ?? (e as Error).message ?? 'unknown' });
      throw deny401();
    }
  }

  private async lookup(gid: string): Promise<Lookup> {
    const t = this.now();
    const hit = this.cache.get(gid);
    if (hit && hit.exp > t) return hit.v;
    let data: ShopifyCustomerData;
    try {
      data = await this.o.admin.graphql<ShopifyCustomerData>(RESOLVE_BUYER_QUERY, { id: gid });
    } catch (e) {
      if (e instanceof HttpError && e.status === 503) throw e;
      throw new HttpError(503, 'Account lookup temporarily unavailable');
    }
    const v = this.interpret(data);
    this.cache.set(gid, { exp: t + this.ttl, v });
    if (this.cache.size > 1000) for (const [k, e] of this.cache) if (e.exp <= t) this.cache.delete(k);
    return v;
  }

  private interpret(data: ShopifyCustomerData): Lookup {
    const profiles = data?.customer?.companyContactProfiles;
    if (!Array.isArray(profiles) || profiles.length !== 1) return { denied: true };
    const p = profiles[0]!;
    const roles = (p.roleAssignments?.nodes ?? []).map(n => n?.role?.name).filter((r): r is string => typeof r === 'string');
    if (!p.company?.id || !roles.some(r => this.roles.includes(r))) return { denied: true };
    return { companyId: p.company.id, companyExternalId: p.company.externalId ?? null, roles };
  }

  private log(event: string, fields: Record<string, string>) {
    (this.o.log ?? ((e, f) => console.warn(JSON.stringify({ event: `identity.${e}`, ...f }))))(event, fields);
  }
}
