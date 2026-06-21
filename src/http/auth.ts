import type { FastifyRequest } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { hashKey, keyPrefix, safeHashEqual } from "../crypto/apikeys.js";
import { unauthorized, forbidden } from "../util.js";
import type { Tier } from "./limits.js";

export interface AuthCtx {
  keyId: string;
  tenantId: string;
  tier: Tier;
  scopes: string[];
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthCtx;
  }
}

/** Resolve the Bearer API key -> tenant. Throws 401 on any failure. */
export async function authenticate(req: FastifyRequest): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw unauthorized();
  const raw = header.slice(7).trim();

  const key = await db.query.apiKeys.findFirst({
    where: and(eq(schema.apiKeys.keyPrefix, keyPrefix(raw)), isNull(schema.apiKeys.revokedAt)),
  });
  if (!key || !safeHashEqual(key.keyHash, hashKey(raw))) throw unauthorized();

  const tenant = await db.query.tenants.findFirst({ where: eq(schema.tenants.id, key.tenantId) });
  if (!tenant) throw unauthorized();

  req.auth = { keyId: key.id, tenantId: tenant.id, tier: tenant.tier as Tier, scopes: key.scopes };

  // Fire-and-forget usage stamp.
  void db.update(schema.apiKeys).set({ lastUsedAt: new Date(), lastUsedIp: req.ip }).where(eq(schema.apiKeys.id, key.id));
}

export function requireScope(req: FastifyRequest, scope: string): void {
  const scopes = req.auth?.scopes ?? [];
  if (!scopes.includes(scope) && !scopes.includes("admin")) throw forbidden(`Missing required scope: ${scope}`);
}
