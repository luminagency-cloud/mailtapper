import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  customType,
  inet,
  unique,
} from "drizzle-orm/pg-core";

/** bytea column type (Drizzle has no first-class bytea helper). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const tenants = pgTable("tenants", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  tier: text("tier", { enum: ["free", "pro", "scale"] }).notNull().default("free"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** API keys: only a hash + a prefix are stored. The full key is shown once, at creation. */
export const apiKeys = pgTable("api_keys", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  keyPrefix: text("key_prefix").notNull().unique(), // e.g. "mtapper_live_AbCd1234"
  keyHash: text("key_hash").notNull(),              // sha256(full key), hex
  scopes: text("scopes").array().notNull().default(["messages:read"]),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  lastUsedIp: inet("last_used_ip"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

/** Envelope-encryption data keys: one (current) DEK per tenant, stored wrapped by the KEK. */
export const tenantKeys = pgTable("tenant_keys", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
  dekWrapped: bytea("dek_wrapped").notNull(),
  dekIv: bytea("dek_iv").notNull(),
  kekVersion: integer("kek_version").notNull(),
  dekVersion: integer("dek_version").notNull(),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** A registered mailbox. Holds credentials (encrypted) — never message content. */
export const connections = pgTable(
  "connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }).notNull(),
    // Optional human nickname only. The admin UI treats username/email as the
    // account identity; label is just a friendly disambiguator like "old host".
    label: text("label"),
    protocol: text("protocol", { enum: ["imap"] }).notNull().default("imap"), // pop3 later
    host: text("host").notNull(),
    port: integer("port").notNull(),
    tlsMode: text("tls_mode", { enum: ["ssl", "starttls", "none"] }).notNull().default("ssl"),
    allowInvalidCert: boolean("allow_invalid_cert").notNull().default(false),
    username: text("username").notNull(),
    secretCiphertext: bytea("secret_ciphertext").notNull(),
    secretIv: bytea("secret_iv").notNull(),
    secretDekId: uuid("secret_dek_id").references(() => tenantKeys.id),
    // Provider is an API tag returned on messages, not authentication data.
    // "imap_generic" means "plain IMAP; no branded provider normalization known".
    // The admin UI labels this optional metadata as "Host name" to avoid exposing
    // internal provider-tag language.
    provider: text("provider").notNull().default("imap_generic"),
    // Stable account identity returned on message JSON. For v1 this should normally
    // mirror username/email; the dashboard does not expose it as a separate field.
    sourceAccount: text("source_account").notNull(),
    status: text("status", { enum: ["pending", "active", "error", "paused"] }).notNull().default("pending"),
    lastError: text("last_error"),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ uniqMailbox: unique().on(t.tenantId, t.username, t.host) }),
);

export type Connection = typeof connections.$inferSelect;
export type Tenant = typeof tenants.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
