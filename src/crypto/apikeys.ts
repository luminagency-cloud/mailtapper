import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * API keys are 256-bit random tokens, so a fast hash (SHA-256) is the correct
 * lookup mechanism — Argon2 is for low-entropy human passwords, not full-entropy
 * tokens. We store only sha256(key) + a prefix; the raw key is shown once.
 */
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function base62(bytes: Buffer): string {
  // Simple, non-padded base62 of the random bytes (collision-irrelevant; entropy is in the bytes).
  let out = "";
  for (const b of bytes) out += BASE62.charAt(b % 62);
  return out;
}

export type GeneratedKey = { raw: string; prefix: string; hash: string };

export function generateApiKey(mode: "live" | "test" = "live"): GeneratedKey {
  const body = base62(randomBytes(32));
  const raw = `mtapper_${mode}_${body}`;
  return { raw, prefix: keyPrefix(raw), hash: hashKey(raw) };
}

export function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** First segment used for O(1) lookup + safe display (e.g. "mtapper_live_AbCd1234"). */
export function keyPrefix(raw: string): string {
  return raw.slice(0, 20);
}

export function safeHashEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
