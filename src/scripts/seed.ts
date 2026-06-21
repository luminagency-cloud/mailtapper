/**
 * Bootstrap the first tenant + an admin API key.
 *   npm run seed -- "My tenant name"
 * Prints the raw key ONCE — store it immediately; only its hash is persisted.
 */
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { generateApiKey } from "../crypto/apikeys.js";

const name = process.argv[2] ?? "default";

const [tenant] = await db.insert(schema.tenants).values({ name, tier: env.DEFAULT_TIER }).returning();
const key = generateApiKey("live");
await db.insert(schema.apiKeys).values({
  tenantId: tenant!.id,
  keyPrefix: key.prefix,
  keyHash: key.hash,
  scopes: ["admin"], // full access for your own bootstrap key; issue scoped keys for consumers
});

console.log(`\nTenant created: ${tenant!.id}  (tier=${tenant!.tier})`);
console.log("\nAPI key (shown once — store it now):\n  " + key.raw + "\n");
process.exit(0);
