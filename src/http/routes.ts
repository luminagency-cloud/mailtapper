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
import { testImapConnection, type MailDiagnosis } from "../imap/validator.js";
import { markMessages, parseMarkReadBody } from "../imap/flags.js";
import { formatSmtpError, testSmtpConnection, type SmtpCfg } from "../smtp/validator.js";
import { assertSendable, deliverMail, mailboxFromAddress, parseSendBody, SEND_ROUTE_BODY_LIMIT } from "../smtp/send.js";
import {
  getOrCreateTenantDek, loadDekById, encryptSecret, decryptSecret, encryptSmtpSecret, decryptSmtpSecret,
} from "../crypto/envelope.js";
import { appendToSent, fetchOne, searchAndFetch, setSeen, type FetchTarget } from "../imap/fetch.js";
import { decodeLocator } from "../imap/locator.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { dashboardHtml } from "./dashboard.js";
import { forbidden, HttpError, notFound, upstream } from "../util.js";
import { serviceVersion } from "../version.js";
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
    // null smtp_* means "not set": host/port/tls fall back to the SMTP_DEFAULT_* env values,
    // username/password fall back to the IMAP login.
    send_enabled: c.sendEnabled, from_name: c.fromName,
    smtp_host: c.smtpHost, smtp_port: c.smtpPort, smtp_tls_mode: c.smtpTlsMode,
    smtp_username: c.smtpUsername, smtp_password_set: c.smtpSecretCiphertext !== null,
    smtp_last_error: c.smtpLastError, smtp_last_validated_at: c.smtpLastValidatedAt,
  };
}

type SmtpFields = Pick<Connection, "smtpHost" | "smtpPort" | "smtpTlsMode" | "smtpUsername" | "username" | "allowInvalidCert">;

/** Effective SMTP settings: the connection's own values, else the env defaults / IMAP login. */
function resolveSmtpCfg(c: SmtpFields): SmtpCfg {
  return {
    host: c.smtpHost ?? env.SMTP_DEFAULT_HOST,
    port: c.smtpPort ?? env.SMTP_DEFAULT_PORT,
    tlsMode: c.smtpTlsMode ?? env.SMTP_DEFAULT_TLS_MODE,
    allowInvalidCert: c.allowInvalidCert,
    username: c.smtpUsername ?? c.username,
  };
}

/** The SMTP password: its own secret if one is stored, else the IMAP password. */
function smtpPasswordFor(c: Connection, dek: Buffer): string {
  return c.smtpSecretCiphertext && c.smtpSecretIv
    ? decryptSmtpSecret(c.smtpSecretCiphertext, c.smtpSecretIv, dek, c.id)
    : decryptSecret(c.secretCiphertext, c.secretIv, dek, c.id);
}

/** 422 body for a failed IMAP/SMTP check: which side, which field, and a hint. */
function setupError(d: MailDiagnosis, code: string) {
  return { error: d.message, code, side: d.side, field: d.field, hint: d.hint };
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

/** Header-safe single line (From display name, usernames). */
const oneLine = z.string().regex(/^[^\r\n]*$/, "Must be a single line");

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
  send_enabled: z.boolean().default(false),
  from_name: oneLine.max(200).optional(),
  // Omitted with send_enabled -> SMTP_DEFAULT_* host/port/tls; username/password -> the IMAP login.
  smtp_host: z.string().min(1).optional(),
  smtp_port: z.number().int().positive().optional(),
  smtp_tls_mode: z.enum(["ssl", "starttls", "none"]).optional(),
  smtp_username: oneLine.min(1).optional(),
  smtp_password: z.string().min(1).optional(),
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
  send_enabled: z.boolean().optional(),
  from_name: oneLine.max(200).nullable().optional(),
  smtp_host: z.string().min(1).optional(),
  smtp_port: z.number().int().positive().optional(),
  smtp_tls_mode: z.enum(["ssl", "starttls", "none"]).optional(),
  // null clears the override and falls back to the IMAP login
  smtp_username: oneLine.min(1).nullable().optional(),
  smtp_password: z.string().min(1).nullable().optional(),
});

const userKeyScopes = ["connections:read", "connections:write", "messages:read", "messages:send", "messages:write"];

const createClientBody = z.object({
  name: z.string().min(1),
  tier: z.enum(["free", "pro", "scale"]).default(env.DEFAULT_TIER),
});

export async function registerRoutes(app: FastifyInstance) {
  app.get("/healthz", async () => ({ ok: true, service: "mailtapper", version: serviceVersion }));

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
    if (!test.ok) return reply.code(422).send(setupError(test, "validation_failed"));

    // Enabling send: pin the effective SMTP settings (defaults included) and prove the login works.
    const smtpHost = body.smtp_host ?? (body.send_enabled ? env.SMTP_DEFAULT_HOST : null);
    const smtpPort = body.smtp_port ?? (body.send_enabled ? env.SMTP_DEFAULT_PORT : null);
    const smtpTlsMode = body.smtp_tls_mode ?? (body.send_enabled ? env.SMTP_DEFAULT_TLS_MODE : null);
    let smtpValidatedAt: Date | null = null;
    if (body.send_enabled) {
      const smtpCfg = resolveSmtpCfg({
        smtpHost, smtpPort, smtpTlsMode, smtpUsername: body.smtp_username ?? null,
        username: body.username, allowInvalidCert: body.allow_invalid_cert,
      });
      const smtpTest = await testSmtpConnection(smtpCfg, body.smtp_password ?? body.password);
      if (!smtpTest.ok) return reply.code(422).send(setupError(smtpTest, "smtp_validation_failed"));
      smtpValidatedAt = new Date();
    }

    const id = randomUUID();
    const { dek, dekId } = await getOrCreateTenantDek(a.tenantId);
    const { iv, blob } = encryptSecret(body.password, dek, id);
    const smtpSecret = body.smtp_password ? encryptSmtpSecret(body.smtp_password, dek, id) : null;

    const [row] = await db
      .insert(schema.connections)
      .values({
        id, tenantId: a.tenantId, label: body.label, host: body.host, port: body.port,
        tlsMode: body.tls_mode, allowInvalidCert: body.allow_invalid_cert, username: body.username,
        secretCiphertext: blob, secretIv: iv, secretDekId: dekId,
        provider: body.provider, sourceAccount: body.source_account ?? body.username,
        status: "active", lastValidatedAt: new Date(),
        sendEnabled: body.send_enabled, fromName: body.from_name ?? null,
        smtpHost, smtpPort, smtpTlsMode, smtpUsername: body.smtp_username ?? null,
        smtpSecretCiphertext: smtpSecret?.blob ?? null, smtpSecretIv: smtpSecret?.iv ?? null,
        smtpLastValidatedAt: smtpValidatedAt,
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

    // SMTP state after this update. Anything that changes the effective SMTP login (including the
    // IMAP username/password it falls back to) re-verifies it when send is (or becomes) enabled.
    const nextSendEnabled = body.send_enabled ?? c.sendEnabled;
    const nextSmtp: SmtpFields = {
      smtpHost: body.smtp_host ?? c.smtpHost ?? (nextSendEnabled ? env.SMTP_DEFAULT_HOST : null),
      smtpPort: body.smtp_port ?? c.smtpPort ?? (nextSendEnabled ? env.SMTP_DEFAULT_PORT : null),
      smtpTlsMode: body.smtp_tls_mode ?? c.smtpTlsMode ?? (nextSendEnabled ? env.SMTP_DEFAULT_TLS_MODE : null),
      smtpUsername: body.smtp_username !== undefined ? body.smtp_username : c.smtpUsername,
      username: effectiveCfg.username,
      allowInvalidCert: effectiveCfg.allowInvalidCert,
    };
    const ownSmtpSecretAfter = body.smtp_password !== undefined ? body.smtp_password !== null : c.smtpSecretCiphertext !== null;
    const smtpChanged =
      (body.send_enabled === true && !c.sendEnabled) ||
      body.smtp_host !== undefined ||
      body.smtp_port !== undefined ||
      body.smtp_tls_mode !== undefined ||
      body.smtp_username !== undefined ||
      body.smtp_password !== undefined ||
      body.allow_invalid_cert !== undefined ||
      (body.username !== undefined && nextSmtp.smtpUsername === null) ||
      (body.password !== undefined && !ownSmtpSecretAfter);
    const testSmtp = nextSendEnabled && smtpChanged;

    let existingPassword: string | undefined;
    let dek: Buffer | undefined;
    if (connectionChanged || body.password !== undefined || testSmtp || body.smtp_password) {
      dek = await loadDekById(c.secretDekId!, a.tenantId);
      existingPassword = decryptSecret(c.secretCiphertext, c.secretIv, dek, c.id);
    }

    const password = body.password ?? existingPassword;
    if (connectionChanged && password) {
      const test = await testImapConnection(effectiveCfg, password);
      if (!test.ok) return reply.code(422).send(setupError(test, "validation_failed"));
    }

    if (testSmtp) {
      const smtpPassword =
        body.smtp_password ??
        (body.smtp_password === null || !c.smtpSecretCiphertext ? password! : smtpPasswordFor(c, dek!));
      const smtpTest = await testSmtpConnection(resolveSmtpCfg(nextSmtp), smtpPassword);
      if (!smtpTest.ok) return reply.code(422).send(setupError(smtpTest, "smtp_validation_failed"));
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
    if (body.send_enabled !== undefined) updates.sendEnabled = body.send_enabled;
    if (body.from_name !== undefined) updates.fromName = body.from_name;
    if (nextSmtp.smtpHost !== c.smtpHost) updates.smtpHost = nextSmtp.smtpHost;
    if (nextSmtp.smtpPort !== c.smtpPort) updates.smtpPort = nextSmtp.smtpPort;
    if (nextSmtp.smtpTlsMode !== c.smtpTlsMode) updates.smtpTlsMode = nextSmtp.smtpTlsMode;
    if (body.smtp_username !== undefined) updates.smtpUsername = body.smtp_username;
    if (body.smtp_password === null) {
      updates.smtpSecretCiphertext = null;
      updates.smtpSecretIv = null;
    } else if (body.smtp_password !== undefined && dek) {
      const { iv, blob } = encryptSmtpSecret(body.smtp_password, dek, c.id);
      updates.smtpSecretCiphertext = blob;
      updates.smtpSecretIv = iv;
    }
    if (testSmtp) {
      updates.smtpLastError = null;
      updates.smtpLastValidatedAt = new Date();
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

  // SMTP login check (connect + AUTH, nothing sent). Uses the env defaults if the connection has
  // no SMTP host yet, so it also answers "would sending work from this mailbox?".
  app.post("/v1/connections/:id/test-smtp", async (req) => {
    const a = ctx(req);
    requireScope(req, "connections:read");
    const c = await loadConnection((req.params as { id: string }).id, a.tenantId);
    const dek = await loadDekById(c.secretDekId!, a.tenantId);
    const cfg = resolveSmtpCfg(c);
    const test = await testSmtpConnection(cfg, smtpPasswordFor(c, dek));
    await db
      .update(schema.connections)
      .set(test.ok ? { smtpLastError: null, smtpLastValidatedAt: new Date() } : { smtpLastError: test.message })
      .where(eq(schema.connections.id, c.id));
    return { ...test, smtp: { host: cfg.host, port: cfg.port, tls_mode: cfg.tlsMode, username: cfg.username } };
  });

  // Send as this mailbox. SMTP host/port/TLS come from the connection, then SMTP_DEFAULT_*.
  // Username/password come from the connection's SMTP secret, then the IMAP login. Never retried.
  app.post("/v1/connections/:id/send", { bodyLimit: SEND_ROUTE_BODY_LIMIT }, async (req) => {
    const a = ctx(req);
    requireScope(req, "messages:send");
    const c = await loadConnection((req.params as { id: string }).id, a.tenantId);
    const body = parseSendBody(req.body ?? {});
    assertSendable(c);
    const fromAddress = mailboxFromAddress(c);
    const dek = await loadDekById(c.secretDekId!, a.tenantId);

    let result;
    try {
      result = await deliverMail(resolveSmtpCfg(c), smtpPasswordFor(c, dek), {
        ...body,
        from: { name: c.fromName, address: fromAddress },
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const message = formatSmtpError(err);
      await db.update(schema.connections).set({ smtpLastError: message }).where(eq(schema.connections.id, c.id));
      req.log.warn({ connectionId: c.id, err: message }, "smtp send failed");
      throw upstream(message);
    }

    let saved: { saved: boolean; folder: string | null; error?: string };
    try {
      saved = await appendToSent(await buildTarget(c, a.tenantId), result.raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not save a copy to the Sent folder";
      req.log.warn({ connectionId: c.id, err: message }, "sent-folder append failed");
      saved = { saved: false, folder: null, error: message };
    }

    await db
      .update(schema.connections)
      .set({ smtpLastError: null, smtpLastValidatedAt: new Date() })
      .where(eq(schema.connections.id, c.id));
    req.log.info({ connectionId: c.id, messageId: result.messageId, savedToSent: saved.saved }, "message sent");

    return {
      ok: true,
      connection_id: c.id,
      message_id: result.messageId,
      accepted: result.accepted,
      rejected: result.rejected,
      saved_to_sent: saved.saved,
      sent_folder: saved.folder,
      sent_error: saved.saved ? null : (saved.error ?? "Could not save a copy to the Sent folder"),
    };
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
    const query = { since, from: q.from, unread: q.unread === "true", subject: q.subject, text: q.q, limit };

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

  // Write `\Seen` back to the mailbox (the flag GET uses for is_unread). `read: false` clears it.
  app.post("/v1/messages/read", async (req) => {
    const a = ctx(req);
    requireScope(req, "messages:write");
    const body = parseMarkReadBody(req.body ?? {});
    const result = await markMessages({
      ids: body.ids,
      read: body.read,
      decode: (id) => decodeLocator(id),
      load: (connectionId) => loadConnection(connectionId, a.tenantId),
      apply: async (connection, _connectionId, items, read) => setSeen(await buildTarget(connection, a.tenantId), items, read),
    });
    if (result.updated.length > 0) messageCache.deletePrefix(`${a.tenantId}:`);
    return { read: body.read, updated: result.updated, failed: result.failed };
  });
}
