import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { env } from "../env.js";
import { HttpError } from "../util.js";
import { authenticate } from "./auth.js";
import { TIERS, type Tier } from "./limits.js";
import { registerRoutes } from "./routes.js";

export async function buildServer() {
  const app = Fastify({ logger: { level: env.LOG_LEVEL }, trustProxy: true });

  // Authenticate first (except health) so the rate limiter can scale by tenant tier.
  app.addHook("onRequest", async (req) => {
    if (req.url.split("?")[0] === "/healthz") return;
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
    if ((err as { statusCode?: number }).statusCode === 429) {
      return reply.code(429).send({ error: "Rate limit exceeded", code: "rate_limited" });
    }
    if ((err as { name?: string }).name === "ZodError") {
      return reply.code(400).send({ error: "Invalid request", code: "bad_request", details: (err as { issues?: unknown }).issues });
    }
    req.log.error(err);
    return reply.code(500).send({ error: "Internal error", code: "internal" });
  });

  await registerRoutes(app);
  return app;
}
