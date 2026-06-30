import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, eq, desc, isNull } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { requireScope } from "./auth.js";
import { TIERS, clampLimit, resolveSince } from "./limits.js";
import { env } from "../env.js";
import { TtlCache } from "../cache/lru.js";
import { generateApiKey } from "../crypto/apikeys.js";
import { testImapConnection } from "../imap/validator.js";
import { getOrCreateTenantDek, loadDekById, encryptSecret, decryptSecret } from "../crypto/envelope.js";
import { searchAndFetch, fetchOne, type FetchTarget } from "../imap/fetch.js";
import { decodeLocator } from "../imap/locator.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { dashboardHtml } from "./dashboard.js";
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

function maxDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
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
  // API/provider tag. Defaults to imap_generic ("plain IMAP, no branded provider").
  // The admin UI exposes this, if at all, as optional "Host name" metadata.
  provider: z.string().default("imap_generic"),
});

const updateBody = z.object({
  label: z.string().nullable().optional(),
  host: z.string().min(1).optional(),
  port: z.number().int().positive().optional(),
  tls_mode: z.enum(["ssl", "starttls", "none"]).optional(),
  allow_invalid_cert: z.boolean().optional(),
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  source_account: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
});

const userKeyScopes = ["connections:read", "connections:write", "messages:read"];

const createClientBody = z.object({
  name: z.string().min(1),
  tier: z.enum(["free", "pro", "scale"]).default(env.DEFAULT_TIER),
});

export async function registerRoutes(app: FastifyInstance) {
  app.get("/healthz", async () => ({ ok: true, service: "mailtapper", version: "0.1.0" }));

  // The only human surface: a thin connection-manager page (served unauthenticated; it holds
  // no secrets — the operator pastes an API key client-side for the /v1/* calls it makes).
  app.get("/", async (_req, reply) => reply.type("text/html").send(dashboardHtml));

  async function loadConnection(id: string, tenantId: string): Promise<Connection> {
    const row = await db.query.connections.findFirst({
      where: and(eq(schema.connections.id, id), eq(schema.connections.tenantId, tenantId)),
    });
    if (!row) throw notFound("Connection not found");
    return row;
  }

  // ---------- Control plane ----------
  app.get("/v1/me", async (req) => {
    const a = ctx(req);
    return {
      tenant_id: a.tenantId,
      key_id: a.keyId,
      tier: a.tier,
      scopes: a.scopes,
      is_admin: a.scopes.includes("admin"),
    };
  });

  app.post("/v1/admin/clients", async (req, reply) => {
    requireScope(req, "admin");
    const body = createClientBody.parse(req.body ?? {});

    const key = generateApiKey("live");
    const tenant = await db.transaction(async (tx) => {
      const [row] = await tx.insert(schema.tenants).values({ name: body.name, tier: body.tier }).returning();
      await tx.insert(schema.apiKeys).values({
        tenantId: row!.id,
        keyPrefix: key.prefix,
        keyHash: key.hash,
        scopes: userKeyScopes,
      });
      return row!;
    });

    return reply.code(201).send({
      id: tenant.id,
      name: tenant.name,
      tier: tenant.tier,
      created_at: tenant.createdAt,
      api_key: key.raw,
      scopes: userKeyScopes,
    });
  });

  app.get("/v1/admin/clients", async (req) => {
    requireScope(req, "admin");

    const [tenants, connections, apiKeys] = await Promise.all([
      db.select().from(schema.tenants).orderBy(desc(schema.tenants.createdAt)),
      db.select().from(schema.connections),
      db.select().from(schema.apiKeys),
    ]);

    const connectionStats = new Map<
      string,
      {
        total: number;
        active: number;
        error: number;
        pending: number;
        paused: number;
        last_validated_at: Date | null;
      }
    >();
    for (const c of connections) {
      const stats =
        connectionStats.get(c.tenantId) ??
        { total: 0, active: 0, error: 0, pending: 0, paused: 0, last_validated_at: null };
      stats.total += 1;
      if (c.status === "active") stats.active += 1;
      if (c.status === "error") stats.error += 1;
      if (c.status === "pending") stats.pending += 1;
      if (c.status === "paused") stats.paused += 1;
      stats.last_validated_at = maxDate(stats.last_validated_at, c.lastValidatedAt);
      connectionStats.set(c.tenantId, stats);
    }

    const keyStats = new Map<string, { total: number; active: number; last_used_at: Date | null }>();
    for (const key of apiKeys) {
      const stats = keyStats.get(key.tenantId) ?? { total: 0, active: 0, last_used_at: null };
      stats.total += 1;
      if (!key.revokedAt) stats.active += 1;
      stats.last_used_at = maxDate(stats.last_used_at, key.lastUsedAt);
      keyStats.set(key.tenantId, stats);
    }

    return {
      data: tenants.map((tenant) => {
        const connections =
          connectionStats.get(tenant.id) ??
          { total: 0, active: 0, error: 0, pending: 0, paused: 0, last_validated_at: null };
        const api_keys = keyStats.get(tenant.id) ?? { total: 0, active: 0, last_used_at: null };
        return {
          id: tenant.id,
          name: tenant.name,
          tier: tenant.tier,
          created_at: tenant.createdAt,
          connections,
          api_keys,
          last_activity_at: maxDate(connections.last_validated_at, api_keys.last_used_at),
        };
      }),
    };
  });

  app.post("/v1/admin/clients/:id/api-key/rotate", async (req) => {
    requireScope(req, "admin");
    const { id } = req.params as { id: string };

    return db.transaction(async (tx) => {
      const [tenant] = await tx.select().from(schema.tenants).where(eq(schema.tenants.id, id)).limit(1);
      if (!tenant) throw notFound("Client not found");

      const activeKeys = await tx
        .select()
        .from(schema.apiKeys)
        .where(and(eq(schema.apiKeys.tenantId, id), isNull(schema.apiKeys.revokedAt)))
        .orderBy(desc(schema.apiKeys.createdAt));

      const scopes = activeKeys.length
        ? Array.from(new Set(activeKeys.flatMap((key) => key.scopes)))
        : userKeyScopes;

      const key = generateApiKey("live");
      await tx
        .update(schema.apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(schema.apiKeys.tenantId, id), isNull(schema.apiKeys.revokedAt)));
      await tx.insert(schema.apiKeys).values({
        tenantId: id,
        keyPrefix: key.prefix,
        keyHash: key.hash,
        scopes,
      });

      return {
        client: { id: tenant.id, name: tenant.name, tier: tenant.tier },
        api_key: key.raw,
        scopes,
      };
    });
  });

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

  app.patch("/v1/connections/:id", async (req, reply) => {
    const a = ctx(req);
    requireScope(req, "connections:write");
    const { id } = req.params as { id: string };
    const c = await loadConnection(id, a.tenantId);
    const body = updateBody.parse(req.body ?? {});

    const effectiveCfg = {
      host: body.host ?? c.host,
      port: body.port ?? c.port,
      tlsMode: body.tls_mode ?? c.tlsMode,
      allowInvalidCert: body.allow_invalid_cert ?? c.allowInvalidCert,
      username: body.username ?? c.username,
    };
    const connectionChanged =
      body.host !== undefined ||
      body.port !== undefined ||
      body.tls_mode !== undefined ||
      body.allow_invalid_cert !== undefined ||
      body.username !== undefined ||
      body.password !== undefined;

    let existingPassword: string | undefined;
    let dek: Buffer | undefined;
    if (connectionChanged || body.password !== undefined) {
      dek = await loadDekById(c.secretDekId!, a.tenantId);
      existingPassword = decryptSecret(c.secretCiphertext, c.secretIv, dek, c.id);
    }

    const password = body.password ?? existingPassword;
    if (connectionChanged && password) {
      const test = await testImapConnection(effectiveCfg, password);
      if (!test.ok) return reply.code(422).send({ error: test.message, code: "validation_failed" });
    }

    const updates: Partial<typeof schema.connections.$inferInsert> = { updatedAt: new Date() };
    if (body.label !== undefined) updates.label = body.label ? body.label : null;
    if (body.host !== undefined) updates.host = body.host;
    if (body.port !== undefined) updates.port = body.port;
    if (body.tls_mode !== undefined) updates.tlsMode = body.tls_mode;
    if (body.allow_invalid_cert !== undefined) updates.allowInvalidCert = body.allow_invalid_cert;
    if (body.username !== undefined) updates.username = body.username;
    if (body.source_account !== undefined) updates.sourceAccount = body.source_account;
    if (body.provider !== undefined) updates.provider = body.provider;
    if (connectionChanged) {
      updates.status = "active";
      updates.lastError = null;
      updates.lastValidatedAt = new Date();
    }
    if (body.password !== undefined && dek) {
      const { iv, blob } = encryptSecret(body.password, dek, c.id);
      updates.secretCiphertext = blob;
      updates.secretIv = iv;
    }

    const [row] = await db
      .update(schema.connections)
      .set(updates)
      .where(and(eq(schema.connections.id, id), eq(schema.connections.tenantId, a.tenantId)))
      .returning();
    return publicConnection(row!);
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

    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    const query = { since, from: q.from, unread: q.unread === "true", subject: q.subject, limit };

    // Fan out (bounded by the tier's concurrency cap); collect candidates tagged by connection + uid.
    const tagged: { connId: string; uid: number; message: UnifiedMessage }[] = [];
    const validities: Record<string, number> = {};
    const cap = TIERS[a.tier].concurrency;
    for (let i = 0; i < targets.length; i += cap) {
      const batch = await Promise.all(
        targets.slice(i, i + cap).map(async (c) => {
          const prev = cursor?.conns[c.id];
          const page = await searchAndFetch(await buildTarget(c, a.tenantId), query, {
            afterUid: prev?.uid,
            expectUidValidity: prev?.uidValidity,
          });
          return { id: c.id, page };
        }),
      );
      for (const { id, page } of batch) {
        validities[id] = page.uidValidity;
        for (const cand of page.candidates) tagged.push({ connId: id, uid: cand.uid, message: cand.message });
      }
    }

    // Global keyset order: newest received_at first, stable tie-break by id.
    tagged.sort((x, y) =>
      x.message.received_at === y.message.received_at
        ? x.message.id < y.message.id
          ? 1
          : -1
        : x.message.received_at < y.message.received_at
          ? 1
          : -1,
    );
    const pageItems = tagged.slice(0, limit);

    // Next cursor: each connection's lowest emitted uid becomes its new ceiling; carry prior
    // ceilings for connections that emitted nothing this page so their candidates re-compete.
    let next_cursor: string | null = null;
    if (pageItems.length === limit) {
      const conns: Record<string, { uid: number; uidValidity: number }> = {};
      if (cursor) {
        for (const [id, st] of Object.entries(cursor.conns)) {
          if (validities[id] !== undefined) conns[id] = st;
        }
      }
      for (const item of pageItems) {
        const uv = validities[item.connId];
        if (uv === undefined) continue;
        const existing = conns[item.connId];
        if (!existing || item.uid < existing.uid) conns[item.connId] = { uid: item.uid, uidValidity: uv };
      }
      next_cursor = encodeCursor({ v: 1, conns });
    }

    const payload = { data: pageItems.map((item) => item.message), next_cursor };
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
