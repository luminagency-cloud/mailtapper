import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../env.js";
import * as schema from "./schema.js";

/**
 * SSL: local Postgres needs none; managed hosts (Neon, etc.) require it. Detect
 * localhost and disable SSL there; enable it everywhere else. rejectUnauthorized is
 * relaxed by default to avoid node-postgres cert-chain hiccups with Neon — set
 * PGSSL_STRICT=1 to enforce full verification.
 */
function sslConfig(url: string) {
  const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
  return isLocal ? undefined : { rejectUnauthorized: process.env.PGSSL_STRICT === "1" };
}

// A small pool is plenty — the DB only holds config + credentials, never mail.
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 5, ssl: sslConfig(env.DATABASE_URL) });

export const db = drizzle(pool, { schema });
export { schema };