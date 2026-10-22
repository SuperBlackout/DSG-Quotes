import pg from "pg";
import { ZohoClient, loadZohoConfigFromEnv } from "@dsg/zoho";
import { AccountMapRepo } from "@dsg/statement";

/**
 * `pnpm -F api add-mapping gid://shopify/Company/123 CUS-1048`
 * Looks the Customer Number up in Zoho (read-only), refuses unless exactly that customer exists, then links the
 * Shopify company to it. Until a company is linked its buyers get 403 on every account page.
 */
const [gid, num] = process.argv.slice(2);
if (!gid || !/^gid:\/\/shopify\/Company\/\d+$/.test(gid) || !num) {
  console.error("Usage: pnpm -F api add-mapping gid://shopify/Company/<id> <CUS-number>");
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url });
try {
  const zoho = new ZohoClient(loadZohoConfigFromEnv());
  const c = await zoho.findContactByCustomerNumber(num);
  if (!c || c.customer_number.trim() !== num.trim()) throw new Error(`No Zoho customer with Customer Number ${num}`);
  await new AccountMapRepo(pool).upsert({ shopifyCompanyId: gid, zohoCustomerId: c.contact_id, customerNumber: c.customer_number, displayName: c.contact_name, active: true });
  console.log(`Linked ${gid} -> ${c.contact_name} (${c.customer_number}, Zoho id ${c.contact_id})`);
} catch (e) {
  console.error("Not linked:", (e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
