import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { env } from "../env.js";
import { db, schema } from "../db/client.js";

/**
 * Envelope encryption (KEK -> DEK).
 *  - KEK (master key): 32 random bytes from env, loaded as a versioned keyring.
 *    Move to a KMS later; only the loader changes, not the data.
 *  - DEK (per-tenant): random 32 bytes that actually encrypt mailbox secrets,
 *    stored wrapped by the KEK in `tenant_keys`.
 * Cipher: AES-256-GCM, random 12-byte IV, 16-byte auth tag appended to ciphertext,
 * AAD binds each ciphertext to its row so it can't be transplanted.
 */

const CURRENT_KEK_VERSION = 1;
const KEYRING: Record<number, Buffer> = {
  1: Buffer.from(env.MAILTAPPER_KEK_B64, "base64"), // validated to be 32 bytes in env.ts
};

function kek(version: number): Buffer {
  const k = KEYRING[version];
  if (!k) throw new Error(`Unknown KEK version ${version}`);
  return k;
}

function gcmEncrypt(key: Buffer, plaintext: Buffer, aad: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, blob: Buffer.concat([enc, cipher.getAuthTag()]) };
}

function gcmDecrypt(key: Buffer, iv: Buffer, blob: Buffer, aad: string): Buffer {
  const tag = blob.subarray(blob.length - 16);
  const ct = blob.subarray(0, blob.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Encrypt a mailbox password under a tenant DEK, bound to the connection id. */
export function encryptSecret(plaintext: string, dek: Buffer, connectionId: string) {
  return gcmEncrypt(dek, Buffer.from(plaintext, "utf8"), `conn:${connectionId}`);
}

export function decryptSecret(blob: Buffer, iv: Buffer, dek: Buffer, connectionId: string): string {
  return gcmDecrypt(dek, iv, blob, `conn:${connectionId}`).toString("utf8");
}

/** Get the tenant's current (non-retired) DEK, creating one on first use. Returns { dek, dekId }. */
export async function getOrCreateTenantDek(tenantId: string): Promise<{ dek: Buffer; dekId: string }> {
  const existing = await db.query.tenantKeys.findFirst({
    where: and(eq(schema.tenantKeys.tenantId, tenantId), isNull(schema.tenantKeys.retiredAt)),
  });
  if (existing) {
    const dek = gcmDecrypt(kek(existing.kekVersion), existing.dekIv, existing.dekWrapped, `dek:${tenantId}`);
    return { dek, dekId: existing.id };
  }
  const dek = randomBytes(32);
  const { iv, blob } = gcmEncrypt(kek(CURRENT_KEK_VERSION), dek, `dek:${tenantId}`);
  const [row] = await db
    .insert(schema.tenantKeys)
    .values({ tenantId, dekWrapped: blob, dekIv: iv, kekVersion: CURRENT_KEK_VERSION, dekVersion: 1 })
    .returning({ id: schema.tenantKeys.id });
  return { dek, dekId: row!.id };
}

/** Load a specific DEK by id (used when decrypting an existing connection's secret). */
export async function loadDekById(dekId: string, tenantId: string): Promise<Buffer> {
  const row = await db.query.tenantKeys.findFirst({ where: eq(schema.tenantKeys.id, dekId) });
  if (!row) throw new Error("DEK not found");
  return gcmDecrypt(kek(row.kekVersion), row.dekIv, row.dekWrapped, `dek:${tenantId}`);
}

// TODO(rotation): rotateKek() re-wraps every tenant_keys row under a new KEK version;
// rotateTenantDek() re-encrypts one tenant's connection secrets under a fresh DEK.
