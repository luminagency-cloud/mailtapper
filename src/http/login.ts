/**
 * Dashboard sign-in by email link: no passwords, and API keys stay for programs.
 *   POST /auth/login   {email}  mails a one-time link (15 min) through LOGIN_SENDER_CONNECTION_ID.
 *   POST /auth/confirm {token}  the dashboard posts the token from the link; sets the session cookie (30 days).
 *   POST /auth/logout           ends the session.
 * The link opens the dashboard, which asks for one tap before it posts the token. A mail
 * scanner that only GETs the link therefore cannot use it up.
 */
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { env } from "../env.js";
import { hashKey } from "../crypto/apikeys.js";
import { loadDekById } from "../crypto/envelope.js";
import { deliverMail, mailboxFromAddress, type OutboundTransport } from "../smtp/send.js";
import type { SmtpCfg } from "../smtp/validator.js";
import { HttpError, unauthorized } from "../util.js";
import { readSessionCookie, SESSION_COOKIE } from "./auth.js";
import { resolveSmtpCfg, smtpPasswordFor, userKeyScopes } from "./routes.js";

export const LINK_TTL_MS = 15 * 60_000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

const newToken = () => randomBytes(32).toString("base64url");

export function sessionCookie(token: string, maxAgeMs: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

/** Mail the link from the configured sender mailbox. */
async function sendLoginLink(
  to: string,
  url: string,
  deps?: { createTransport?: (cfg: SmtpCfg, password: string) => OutboundTransport },
): Promise<void> {
  const c = await db.query.connections.findFirst({ where: eq(schema.connections.id, env.LOGIN_SENDER_CONNECTION_ID!) });
  if (!c || !c.sendEnabled) throw new HttpError(503, "The sign-in sender mailbox is missing or cannot send", "login_unavailable");
  const dek = await loadDekById(c.secretDekId!, c.tenantId);
  await deliverMail(
    resolveSmtpCfg(c),
    smtpPasswordFor(c, dek),
    {
      from: { name: "MailTapper", address: mailboxFromAddress(c) },
      to: [{ email: to }], cc: [], bcc: [], replyTo: [], references: [],
      subject: "Your MailTapper sign-in link",
      text:
        `Sign in to MailTapper:\n\n${url}\n\n` +
        "This link works once and expires in 15 minutes. If you did not ask for it, ignore this email.\n",
    },
    deps,
  );
}

export function registerLogin(
  app: FastifyInstance,
  deps?: { createTransport?: (cfg: SmtpCfg, password: string) => OutboundTransport },
) {
  // 5 links per IP per 15 minutes: enough for a typo, not enough to mail-bomb someone.
  app.post("/auth/login", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (req) => {
    const { email } = z.object({ email: z.string().trim().toLowerCase().email().max(320) }).parse(req.body ?? {});
    if (!env.LOGIN_SENDER_CONNECTION_ID) throw new HttpError(503, "Email sign-in is not set up on this server", "login_unavailable");

    await db.delete(schema.logins).where(lt(schema.logins.expiresAt, new Date()));
    const tenant = await db.query.tenants.findFirst({ where: eq(schema.tenants.email, email) });
    if (tenant) {
      const token = newToken();
      await db.insert(schema.logins).values({
        tenantId: tenant.id,
        linkHash: hashKey(token),
        expiresAt: new Date(Date.now() + LINK_TTL_MS),
      });
      const url = new URL(`/?login=${token}`, env.PUBLIC_BASE_URL).toString();
      try {
        await sendLoginLink(email, url, deps);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        const code = (err as { code?: unknown })?.code;
        throw new HttpError(502, "Could not send the sign-in email. Try again in a minute.", "upstream_error",
          typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : undefined);
      }
    }
    // Same answer for unknown addresses, so the form does not reveal who has an account.
    return { ok: true, message: `If ${email} has an account, a sign-in link is on its way. It expires in 15 minutes.` };
  });

  app.post("/auth/confirm", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const { token } = z.object({ token: z.string().min(20).max(100) }).parse(req.body ?? {});
    const session = newToken();
    const now = new Date();
    // One UPDATE does the check and the use, so two taps on the same link cannot both win.
    const [login] = await db
      .update(schema.logins)
      .set({ linkHash: null, sessionHash: hashKey(session), expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
      .where(and(eq(schema.logins.linkHash, hashKey(token)), isNull(schema.logins.sessionHash), gt(schema.logins.expiresAt, now)))
      .returning();
    if (!login) throw unauthorized("This sign-in link has expired or was already used. Ask for a new one.");

    // The session acts with the same scopes as the account's active API keys.
    const keys = await db
      .select({ scopes: schema.apiKeys.scopes })
      .from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.tenantId, login.tenantId), isNull(schema.apiKeys.revokedAt)));
    const scopes = keys.length ? Array.from(new Set(keys.flatMap((k) => k.scopes))) : userKeyScopes;
    await db.update(schema.logins).set({ scopes }).where(eq(schema.logins.id, login.id));

    return reply.header("set-cookie", sessionCookie(session, SESSION_TTL_MS)).send({ ok: true });
  });

  app.post("/auth/logout", async (req, reply) => {
    const token = readSessionCookie(req.headers.cookie);
    if (token) await db.delete(schema.logins).where(eq(schema.logins.sessionHash, hashKey(token)));
    return reply.header("set-cookie", sessionCookie("", 0)).send({ ok: true });
  });
}
