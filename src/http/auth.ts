import type { FastifyRequest } from "fastify";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { hashKey, keyPrefix, safeHashEqual } from "../crypto/apikeys.js";
import { unauthorized, forbidden } from "../util.js";
import type { Tier } from "./limits.js";

export interface AuthCtx {
  /** API key id, or the login (session) id for a dashboard sign-in. */
  keyId: string;
  tenantId: string;
  tier: Tier;
  scopes: string[];
  via: "key" | "session";
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthCtx;
  }
}

export const SESSION_COOKIE = "mt_session";
/** Cookie-authenticated writes must carry this header. Cross-site forms cannot set it (CSRF guard on top of SameSite=Strict). */
export const SESSION_HEADER = "x-mailtapper";

export function readSessionCookie(header: string | undefined): string | null {
  const m = header?.match(/(?:^|;\s*)mt_session=([A-Za-z0-9_-]{20,})/);
  return m ? m[1]! : null;
}

/** Resolve the Bearer API key (or the dashboard session cookie) -> tenant. Throws 401 on any failure. */
export async function authenticate(req: FastifyRequest): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return authenticateSession(req);
  const raw = header.slice(7).trim();

  const key = await db.query.apiKeys.findFirst({
    where: and(eq(schema.apiKeys.keyPrefix, keyPrefix(raw)), isNull(schema.apiKeys.revokedAt)),
  });
  if (!key || !safeHashEqual(key.keyHash, hashKey(raw))) throw unauthorized();

  const tenant = await db.query.tenants.findFirst({ where: eq(schema.tenants.id, key.tenantId) });
  if (!tenant) throw unauthorized();

  req.auth = { keyId: key.id, tenantId: tenant.id, tier: tenant.tier as Tier, scopes: key.scopes, via: "key" };

  // Fire-and-forget usage stamp.
  void db.update(schema.apiKeys).set({ lastUsedAt: new Date(), lastUsedIp: req.ip }).where(eq(schema.apiKeys.id, key.id));
}

async function authenticateSession(req: FastifyRequest): Promise<void> {
  const token = readSessionCookie(req.headers.cookie);
  if (!token) throw unauthorized();
  if (req.method !== "GET" && req.method !== "HEAD" && req.headers[SESSION_HEADER] !== "1") {
    throw forbidden(`Cookie-authenticated writes need the ${SESSION_HEADER}: 1 header`);
  }
  const login = await db.query.logins.findFirst({
    where: and(eq(schema.logins.sessionHash, hashKey(token)), gt(schema.logins.expiresAt, new Date())),
  });
  if (!login) throw unauthorized("Signed out. Sign in again.");
  const tenant = await db.query.tenants.findFirst({ where: eq(schema.tenants.id, login.tenantId) });
  if (!tenant) throw unauthorized();
  req.auth = { keyId: login.id, tenantId: tenant.id, tier: tenant.tier as Tier, scopes: login.scopes, via: "session" };
}

export function requireScope(req: FastifyRequest, scope: string): void {
  const scopes = req.auth?.scopes ?? [];
  if (!scopes.includes(scope) && !scopes.includes("admin")) throw forbidden(`Missing required scope: ${scope}`);
}
