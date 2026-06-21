import "dotenv/config"; // so drizzle-kit (db:push / db:generate) sees DATABASE_URL from .env
import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
} satisfies Config;
