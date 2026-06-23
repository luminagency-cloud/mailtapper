/**
 * Issue an API key for an EXISTING tenant.
 *   npx tsx src/scripts/issue-key.ts                      # admin key (default), single tenant
 *   npx tsx src/scripts/issue-key.ts messages:read        # read-only key (for a consumer like luminmail)
 *   npx tsx src/scripts/issue-key.ts messages:read <tenantId>
 * Scopes are comma-separated. Prints the raw key once — only its hash is stored.
 */
import { db, schema } from "../db/client.js";
import { generateApiKey } from "../crypto/apikeys.js";

const scopesArg = process.argv[2] ?? "admin";
const tenantArg = process.argv[3];
const scopes = scopesArg.split(",").map((s) => s.trim()).filter(Boolean);

const tenants = await db.select().from(schema.tenants);
if (tenants.length === 0) {
  console.error("No tenants yet — run `npm run seed` first.");
  process.exit(1);
}

const tenant = tenantArg ? tenants.find((t) => t.id === tenantArg) : tenants.length === 1 ? tenants[0] : undefined;
if (!tenant) {
  console.error(tenantArg ? `No tenant with id ${tenantArg}.` : "Multiple tenants — pass one as the 2nd arg.");
  console.error("Tenants:\n" + tenants.map((t) => `  ${t.id}  ${t.name}`).join("\n"));
  process.exit(1);
}

const key = generateApiKey("live");
await db.insert(schema.apiKeys).values({
  tenantId: tenant.id,
  keyPrefix: key.prefix,
  keyHash: key.hash,
  scopes,
});
console.log(`\nNew key for tenant ${tenant.id} (${tenant.name})\n  scopes: ${scopes.join(", ")}\n  key:    ${key.raw}\n`);
process.exit(0);
