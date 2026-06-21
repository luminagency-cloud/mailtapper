import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, eq, desc } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { requireScope } from "./auth.js";
import { TIERS, clampLimit, resolveSince } from "./limits.js";
import { env } from "../env.js";
import { TtlCache } from "../cache/lru.js";
import { testImapConnection } from "../imap/validator.js";
import { getOrCreateTenantDek, loadDekById, encryptSecret, decryptSecret } from "../crypto/envelope.js";
import { searchAndFetch, fetchOne, type FetchTarget } from "../imap/fetch.js";
import { decodeLocator } from "../imap/locator.js";
import { forbidden, notFound } from "../util.js";
import type { Connection } from "../db/schema.js";
import type { UnifiedMessage } from "../imap/normalize.js";

const messageCache = new TtlCache<{ data: UnifiedMessage[]; next_cursor: string | null }>(env.CACHE_TTL_SECONDS * 1000);

const ctx = (req: FastifyRequest) => req.auth!; // guaranteed by the auth hook on non-health routes

function publicConnection(c: Connection) {
  return {
    id: c.id, label: c.label, provider: c.provider, host: c.host, port: c.port,
    tls_mode: c.tlsMode, allow_invalid_cert: c.allowInvalidCert, username: c.username,
    source_account: c.sourceAccount, status: c.status, last_error: c.lastError,
    last_validated_at: c.lastValidatedAt, created_at: c.createdAt,
  };
}

async function buildTarget(c: Connection, tenantId: string): Promise<FetchTarget> {
  const dek = await loadDekById(c.secretDekId!, tenantId);
  const password = decryptSecret(c.secretCiphertext, c.secretIv, dek, c.id);
  return {
    connectionId: c.id, sourceAccount: c.sourceAccount, provider: c.provider,
    host: c.host, port: c.port, tlsMode: c.tlsMode, allowInvalidCert: c.allowInvalidCert,
    username: c.username, password,
  };
}

const createBody = z.object({
  label: z.string().optional(),
  host: z.string().min(1),
  port: z.number().int().positive(),
  tls_mode: z.enum(["ssl", "starttls", "none"]).default("ssl"),
  allow_invalid_cert: z.boolean().default(false),
  username: z.string().min(1),
  password: z.string().min(1),
  source_account: z.string().optional(),
  provider: z.string().default("imap_generic"),
});

export async function registerRoutes(app: FastifyInstance) {
  app.get("/healthz", async () => ({ ok: true, service: "mailtapper", version: "0.1.0" }));

  async function loadConnection(id: string, tenantId: string): Promise<Connection> {
    const row = await db.query.connections.findFirst({
      where: and(eq(schema.connections.id, id), eq(schema.connections.tenantId, tenantId)),
    });
    if (!row) throw notFound("Connection not found");
    return row;
  }

  // ---------- Control plane ----------
  app.post("/v1/connections", async (req, reply) => {
    const a = ctx(req);
    requireScope(req, "connections:write");
    const body = createBody.parse(req.body);

    const existing = await db.select({ id: schema.connections.id }).from(schema.connections).where(eq(schema.connections.tenantId, a.tenantId));
    if (existing.length >= TIERS[a.tier].connections) {
      throw forbidden(`Connection cap reached for your plan (${TIERS[a.tier].connections}). Upgrade to add more.`);
    }

    const cfg = { host: body.host, port: body.port, tlsMode: body.tls_mode, allowInvalidCert: body.allow_invalid_cert, username: body.username };
    const test = await testImapConnection(cfg, body.password);
    if (!test.ok) return reply.code(422).send({ error: test.message, code: "validation_failed" });

    const id = randomUUID();
    const { dek, dekId } = await getOrCreateTenantDek(a.tenantId);
    const { iv, blob } = encryptSecret(body.password, dek, id);

    const [row] = await db
      .insert(schema.connections)
      .values({
        id, tenantId: a.tenantId, label: body.label, host: body.host, port: body.port,
        tlsMode: body.tls_mode, allowInvalidCert: body.allow_invalid_cert, username: body.username,
        secretCiphertext: blob, secretIv: iv, secretDekId: dekId,
        provider: body.provider, sourceAccount: body.source_account ?? body.username,
        status: "active", lastValidatedAt: new Date(),
      })
      .returning();
    return reply.code(201).send(publicConnection(row!));
  });

  app.get("/v1/connections", async (req) => {
    const a = ctx(req);
    requireScope(req, "connections:read");
    const rows = await db.select().from(schema.connections).where(eq(schema.connections.tenantId, a.tenantId)).orderBy(desc(schema.connections.createdAt));
    return { data: rows.map(publicConnection) };
  });

  app.get("/v1/connections/:id", async (req) => {
    const a = ctx(req);
    requireScope(req, "connections:read");
    return publicConnection(await loadConnection((req.params as { id: string }).id, a.tenantId));
  });

  app.delete("/v1/connections/:id", async (req, reply) => {
    const a = ctx(req);
    requireScope(req, "connections:write");
    const { id } = req.params as { id: string };
    await loadConnection(id, a.tenantId); // 404s if not theirs
    await db.delete(schema.connections).where(and(eq(schema.connections.id, id), eq(schema.connections.tenantId, a.tenantId)));
    return reply.code(204).send();
  });

  app.post("/v1/connections/:id/test", async (req) => {
    const a = ctx(req);
    requireScope(req, "connections:read");
    const c = await loadConnection((req.params as { id: string }).id, a.tenantId);
    const dek = await loadDekById(c.secretDekId!, a.tenantId);
    const password = decryptSecret(c.secretCiphertext, c.secretIv, dek, c.id);
    const test = await testImapConnection({ host: c.host, port: c.port, tlsMode: c.tlsMode, allowInvalidCert: c.allowInvalidCert, username: c.username }, password);
    await db
      .update(schema.connections)
      .set(test.ok ? { status: "active", lastError: null, lastValidatedAt: new Date() } : { status: "error", lastError: test.message })
      .where(eq(schema.connections.id, c.id));
    return test;
  });

  // TODO: PATCH /v1/connections/:id — update settings; re-validate when host/creds/tls change.

  // ---------- Data plane (live fetch) ----------
  app.get("/v1/messages", async (req) => {
    const a = ctx(req);
    requireScope(req, "messages:read");
    const q = req.query as Record<string, string | undefined>;
    const since = resolveSince(a.tier, q.since);
    const limit = clampLimit(a.tier, q.limit ? Number(q.limit) : undefined);

    const cacheKey = `${a.tenantId}:${JSON.stringify({ ...q, since: since.toISOString(), limit })}`;
    const hit = messageCache.get(cacheKey);
    if (hit) return hit;

    const targets = await db
      .select()
      .from(schema.connections)
      .where(
        q.connection_id
          ? and(eq(schema.connections.tenantId, a.tenantId), eq(schema.connections.id, q.connection_id), eq(schema.connections.status, "active"))
          : and(eq(schema.connections.tenantId, a.tenantId), eq(schema.connections.status, "active")),
      );
    if (q.connection_id && targets.length === 0) throw notFound("Connection not found");

    const query = { since, from: q.from, unread: q.unread === "true", subject: q.subject, limit };

    // Fan out across connections, bounded by the tier's concurrency cap.
    const all: UnifiedMessage[] = [];
    const cap = TIERS[a.tier].concurrency;
    for (let i = 0; i < targets.length; i += cap) {
      const batch = await Promise.all(
        targets.slice(i, i + cap).map(async (c) => searchAndFetch(await buildTarget(c, a.tenantId), query)),
      );
      for (const arr of batch) all.push(...arr);
    }

    all.sort((x, y) => (x.received_at < y.received_at ? 1 : -1));
    // TODO(pagination): emit a keyset next_cursor on (received_at, id) for cross-connection paging.
    const payload = { data: all.slice(0, limit), next_cursor: null };
    messageCache.set(cacheKey, payload);
    return payload;
  });

  app.get("/v1/messages/:id", async (req) => {
    const a = ctx(req);
    requireScope(req, "messages:read");
    const loc = decodeLocator((req.params as { id: string }).id);
    const c = await loadConnection(loc.connectionId, a.tenantId);
    return fetchOne(await buildTarget(c, a.tenantId), loc.folder, loc.uid, loc.uidValidity);
  });
}
