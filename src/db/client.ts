import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../env.js";
import * as schema from "./schema.js";

// A small pool is plenty — the DB only holds config + credentials, never mail.
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 5 });

export const db = drizzle(pool, { schema });
export { schema };
