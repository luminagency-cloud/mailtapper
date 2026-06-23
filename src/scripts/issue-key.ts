/**
<<<<<<< HEAD
 * Issue a NEW admin API key for an EXISTING tenant (use when you've lost the seed key).
 *   npx tsx src/scripts/issue-key.ts            # if there's exactly one tenant
 *   npx tsx src/scripts/issue-key.ts <tenantId> # if you have several
 * Prints the raw key once — only its hash is stored.
=======
 * Issue an API key for an EXISTING tenant.
 *   npx tsx src/scripts/issue-key.ts                      # admin key (default), single tenant
 *   npx tsx src/scripts/issue-key.ts messages:read        # read-only key (for a consumer like luminmail)
 *   npx tsx src/scripts/issue-key.ts messages:read <tenantId>
 * Scopes are comma-separated. Prints the raw key once — only its hash is stored.
>>>>>>> refs/remotes/origin/main
 */
import { db, schema } from "../db/client.js";
import { generateApiKey } from "../crypto/apikeys.js";

<<<<<<< HEAD
const arg = process.argv[2];
const tenants = await db.select().from(schema.tenants);

=======
const scopesArg = process.argv[2] ?? "admin";
const tenantArg = process.argv[3];
const scopes = scopesArg.split(",").map((s) => s.trim()).filter(Boolean);

const tenants = await db.select().from(schema.tenants);
>>>>>>> refs/remotes/origin/main
if (tenants.length === 0) {
  console.error("No tenants yet — run `npm run seed` first.");
  process.exit(1);
}

<<<<<<< HEAD
const tenant = arg ? tenants.find((t) => t.id === arg) : tenants.length === 1 ? tenants[0] : undefined;

if (!tenant) {
  console.error(arg ? `No tenant with id ${arg}.` : "Multiple tenants — pass one as an argument.");
=======
const tenant = tenantArg ? tenants.find((t) => t.id === tenantArg) : tenants.length === 1 ? tenants[0] : undefined;
if (!tenant) {
  console.error(tenantArg ? `No tenant with id ${tenantArg}.` : "Multiple tenants — pass one as the 2nd arg.");
>>>>>>> refs/remotes/origin/main
  console.error("Tenants:\n" + tenants.map((t) => `  ${t.id}  ${t.name}`).join("\n"));
  process.exit(1);
}

const key = generateApiKey("live");
await db.insert(schema.apiKeys).values({
  tenantId: tenant.id,
  keyPrefix: key.prefix,
  keyHash: key.hash,
<<<<<<< HEAD
  scopes: ["admin"],
});
console.log(`\nNew admin key for tenant ${tenant.id} (${tenant.name}):\n  ${key.raw}\n`);
process.exit(0);
=======
  scopes,
});
console.log(`\nNew key for tenant ${tenant.id} (${tenant.name})\n  scopes: ${scopes.join(", ")}\n  key:    ${key.raw}\n`);
process.exit(0);
>>>>>>> refs/remotes/origin/main
