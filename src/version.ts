import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** package.json "version". Resolves for tsx (src/) and the compiled image (dist/). */
export const serviceVersion = (
  JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")) as { version: string }
).version;
