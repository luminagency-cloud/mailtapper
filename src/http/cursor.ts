import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../env.js";
import { badRequest } from "../util.js";

/**
 * Data-plane pagination cursor. Because there's no stored table to seek in, the
 * cursor carries a per-connection UID ceiling: the next page asks each connection
 * for its newest matching messages with uid < ceiling. uidValidity is stored so a
 * mailbox UID reset invalidates only that connection's ceiling (it restarts newest).
 * HMAC-signed (same secret as the message id locator) so it can't be forged.
 */
export interface CursorState {
  v: 1;
  conns: Record<string, { uid: number; uidValidity: number }>;
}

function sign(payload: string): string {
  return createHmac("sha256", env.MAILTAPPER_LOCATOR_SECRET).update(payload).digest("base64url");
}

export function encodeCursor(state: CursorState): string {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function decodeCursor(token: string): CursorState {
  const [payload, mac] = token.split(".");
  if (!payload || !mac) throw badRequest("Malformed cursor");
  const expected = sign(payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw badRequest("Invalid cursor");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as CursorState;
}
