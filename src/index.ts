import { env } from "./env.js";
import { buildServer } from "./http/server.js";

const app = await buildServer();

try {
  const addr = await app.listen({ host: "0.0.0.0", port: env.PORT });
  app.log.info(`mailtapper v1 (pull-only access layer) listening on ${addr}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
