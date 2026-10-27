import { env } from "./env.js";
import { buildServer } from "./http/server.js";
import { serviceVersion } from "./version.js";

const app = await buildServer();

try {
  const addr = await app.listen({ host: "0.0.0.0", port: env.PORT });
  app.log.info(`mailtapper ${serviceVersion} listening on ${addr}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
