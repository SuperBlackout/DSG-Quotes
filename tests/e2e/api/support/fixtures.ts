/**
 * Fixture data for the runnable layer: 2 companies, 3 dealers, 2 reps, 1 manager (CLAUDE.md rule 8: fake data only).
 * Unit costs are deliberately odd numbers that never collide with a price, quantity or total, so the privacy scan
 * can search every customer response for them.
 */
export const SHOP = "dsg-e2e.myshopify.com";
export const API_SECRET = "e2e-secret-not-real";
export const API_KEY = "e2e-client-id";

// ---------------------------------------------------------------- companies and locations
export const ACME = { id: "gid://shopify/Company/1", name: "Acme Dealers" };
export const OTHERCO = { id: "gid://shopify/Company/2", name: "Other Co" };
export const LOC_ACME_MAIN = "gid://shopify/CompanyLocation/1";
export const LOC_ACME_BRANCH = "gid://shopify/CompanyLocation/2";
export const LOC_OTHER_HQ = "gid://shopify/CompanyLocation/3";

// ---------------------------------------------------------------- dealers (customers)
export const DANA = { id: "gid://shopify/Customer/1001", name: "Dana Dealer" }; // Acme, Main + Branch
export const DREW = { id: "gid://shopify/Customer/1002", name: "Drew Dealer" }; // Acme, Main (colleague of Dana)
export const BEA = { id: "gid://shopify/Customer/2001", name: "Bea Buyer" }; // Other Co, HQ
export const NOBODY = "gid://shopify/Customer/9999"; // a customer who is not a company contact

// ---------------------------------------------------------------- staff (Shopify staff ids; rows auto-provisioned)
export const REP1 = { shopifyId: "rep-1", name: "Rita Rep" };
export const REP2 = { shopifyId: "rep-2", name: "Ross Rep" };
export const MANAGER = { shopifyId: "mgr-1", name: "Maya Manager" };
export const DEFAULT_FLOOR_PCT = 15;

// ---------------------------------------------------------------- catalog
export const V_PIPE = "gid://shopify/ProductVariant/11"; // list 120.00, cost 61.37 (Other Co sees 110.00)
export const V_VALVE = "gid://shopify/ProductVariant/12"; // list 80.00, cost 23.19
export const V_THIN = "gid://shopify/ProductVariant/13"; // list 100.00, cost 91.43 (8.57% margin: under the 15% floor)
export const V_NOCOST = "gid://shopify/ProductVariant/14"; // list 10.00, cost unknown
export const V_GHOST = "gid://shopify/ProductVariant/99999"; // does not exist

export const PRICE = { PIPE: "120.00", PIPE_OTHERCO: "110.00", VALVE: "80.00", THIN: "100.00", NOCOST: "10.00" } as const;
export const COST = { PIPE: "61.37", VALVE: "23.19", THIN: "91.43" } as const;

/** Every planted cost value; none may ever appear in a customer response. */
export const COSTS: string[] = Object.values(COST);

/** Text planted in staff-only fields; none may ever appear in a customer response. */
export const SECRET_INTERNAL_NOTE = "SECRET-INTERNAL-NOTE-do-not-show-dealer";
export const SECRET_INTERNAL_MSG = "SECRET-INTERNAL-MSG-they-will-pay-more";
export const SECRET_WORKING_NOTE = "SECRET-WORKING-NOTE-unsent-draft";
export const SECRET_APPROVAL_NOTE = "SECRET-APPROVAL-NOTE-strategic-account";
export const SECRETS = [SECRET_INTERNAL_NOTE, SECRET_INTERNAL_MSG, SECRET_WORKING_NOTE, SECRET_APPROVAL_NOTE];

/** Prices reps may quote in the suite; used to derive every margin the staff API can report. */
const QUOTED_PRICES: Record<keyof typeof COST, number[]> = {
  PIPE: [120, 110, 112.5, 105, 100, 95, 90, 80, 75],
  VALVE: [80, 72.5, 70, 65],
  THIN: [100, 95, 92, 90],
};

/** Staff-visible margin percentages (2 dp, like the API) for the fixture cost x price grid. */
export const MARGIN_FIGURES: string[] = (() => {
  const out = new Set<string>();
  for (const key of Object.keys(COST) as (keyof typeof COST)[]) {
    for (const p of QUOTED_PRICES[key]) {
      const m = Math.round(((p - Number(COST[key])) / p) * 10000) / 100;
      const s = m.toString();
      if (/\.\d\d$/.test(s)) out.add(s); // only distinctive 2-decimal figures, whole numbers would match anything
    }
  }
  return [...out];
})();

export const money = (n: number | string) => Number(n).toFixed(2);
