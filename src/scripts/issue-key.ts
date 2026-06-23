/**
 * Issue a NEW admin API key for an EXISTING tenant (use when you've lost the seed key).
 *   npx tsx src/scripts/issue-key.ts            # if there's exactly one tenant
 *   npx tsx src/scripts/issue-key.ts <tenantId> # if you have several
 * Prints the raw key once — only its hash is stored.
 */
import { db, schema } from "../db/client.js";
import { generateApiKey } from "../crypto/apikeys.js";

const arg = process.argv[2];
const tenants = await db.select().from(schema.tenants);

if (tenants.length === 0) {
  console.error("No tenants yet — run `npm run seed` first.");
  process.exit(1);
}

const tenant = arg ? tenants.find((t) => t.id === arg) : tenants.length === 1 ? tenants[0] : undefined;

if (!tenant) {
  console.error(arg ? `No tenant with id ${arg}.` : "Multiple tenants — pass one as an argument.");
  console.error("Tenants:\n" + tenants.map((t) => `  ${t.id}  ${t.name}`).join("\n"));
  process.exit(1);
}

const key = generateApiKey("live");
await db.insert(schema.apiKeys).values({
  tenantId: tenant.id,
  keyPrefix: key.prefix,
  keyHash: key.hash,
  scopes: ["admin"],
});
console.log(`\nNew admin key for tenant ${tenant.id} (${tenant.name}):\n  ${key.raw}\n`);
process.exit(0);