import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { env } from "../env.js";
import { HttpError } from "../util.js";
import { authenticate } from "./auth.js";
import { TIERS, type Tier } from "./limits.js";
import { registerRoutes } from "./routes.js";

export async function buildServer() {
  const app = Fastify({ logger: { level: env.LOG_LEVEL }, trustProxy: true });

  // Tolerate an empty body on application/json requests (e.g. bodyless POSTs like
  // /connections/:id/test or DELETE) instead of throwing FST_ERR_CTP_EMPTY_JSON_BODY.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const s = typeof body === "string" ? body.trim() : "";
    if (!s) return done(null, undefined);
    try {
      done(null, JSON.parse(s));
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  // Authenticate first (except health) so the rate limiter can scale by tenant tier.
  app.addHook("onRequest", async (req) => {
    const path = req.url.split("?")[0];
    if (path === "/healthz" || path === "/") return; // health check + dashboard shell are unauthenticated
    await authenticate(req);
  });

  await app.register(rateLimit, {
    global: true,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.auth?.keyId ?? req.ip,
    max: (req) => (req.auth ? TIERS[req.auth.tier as Tier].ratePerMin : 30),
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, code: err.code });
    if ((err as { name?: string }).name === "ZodError") {
      return reply.code(400).send({ error: "Invalid request", code: "bad_request", details: (err as { issues?: unknown }).issues });
    }
    // Respect framework errors that carry a client (4xx) status — rate-limit 429, empty/bad JSON 400, etc.
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return reply.code(status).send({ error: err.message, code: (err as { code?: string }).code ?? "error" });
    }
    req.log.error(err);
    return reply.code(500).send({ error: "Internal error", code: "internal" });
  });

  await registerRoutes(app);
  return app;
}