import "dotenv/config"; // auto-load .env (repo root) before anything reads process.env
import { z } from "zod";

/** Validated process env. Fails fast at boot if anything required is missing. */
const schema = z.object({
  DATABASE_URL: z.string().url(),
  MAILTAPPER_KEK_B64: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "MAILTAPPER_KEK_B64 must be 32 random bytes, base64-encoded (openssl rand -base64 32)"),
  MAILTAPPER_LOCATOR_SECRET: z.string().min(16),
  PORT: z.coerce.number().default(4321),
  PUBLIC_BASE_URL: z.string().url(),
  LOG_LEVEL: z.string().default("info"),
  CACHE_TTL_SECONDS: z.coerce.number().default(60),
  DEFAULT_TIER: z.enum(["free", "pro", "scale"]).default("pro"),
  // SMTP defaults applied when a connection enables sending without its own SMTP host.
  // Defaults are StackMail (20i / StackDNS): smtp.stackmail.com:587, STARTTLS, full email as login.
  SMTP_DEFAULT_HOST: z.string().default("smtp.stackmail.com"),
  SMTP_DEFAULT_PORT: z.coerce.number().default(587),
  SMTP_DEFAULT_TLS_MODE: z.enum(["ssl", "starttls", "none"]).default("starttls"),
});

export const env = schema.parse(process.env);
export type Env = z.infer<typeof schema>;
