import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../env.js";
import { gone } from "../util.js";

/**
 * The opaque message `id` returned to callers: it encodes where the message lives
 * (connection + folder + uid + uidvalidity) and is HMAC-signed so it can't be
 * tampered to reach another tenant's connection. Lets us re-fetch a single message
 * statelessly — no stored index needed. (Distinct from `internal_id`, the content
 * hash callers use for their own dedupe.)
 */
export interface Locator {
  connectionId: string;
  folder: string;
  uid: number;
  uidValidity: number;
}

function sign(payload: string): string {
  return createHmac("sha256", env.MAILTAPPER_LOCATOR_SECRET).update(payload).digest("base64url");
}

export function encodeLocator(loc: Locator): string {
  const payload = Buffer.from(JSON.stringify(loc)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function decodeLocator(token: string): Locator {
  const [payload, mac] = token.split(".");
  if (!payload || !mac) throw gone("Malformed message id");
  const expected = sign(payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw gone("Message id signature invalid");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Locator;
}
