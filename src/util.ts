/** Typed HTTP error the routes/handlers throw; the server maps `.status` to a response. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export const badRequest = (m: string) => new HttpError(400, m, "bad_request");
export const unauthorized = (m = "Invalid or missing API key") => new HttpError(401, m, "unauthorized");
export const forbidden = (m: string) => new HttpError(403, m, "forbidden");
export const notFound = (m = "Not found") => new HttpError(404, m, "not_found");
export const gone = (m = "Message locator is stale; re-query") => new HttpError(410, m, "gone");
export const payloadTooLarge = (m: string) => new HttpError(413, m, "payload_too_large");
export const upstream = (m: string) => new HttpError(502, m, "upstream_error");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry with exponential backoff + full jitter. The hygiene layer's answer to
 * flaky long-tail hosts: don't hammer, back off. Throws the last error if all fail.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { tries?: number; baseMs?: number; capMs?: number } = {},
): Promise<T> {
  const { tries = 3, baseMs = 500, capMs = 8000 } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // 4xx is the caller's problem (stale id, oversize attachment). Retrying would
      // just repeat a fetch we already know will fail. 5xx and socket errors still retry.
      if (err instanceof HttpError && err.status >= 400 && err.status < 500) throw err;
      if (attempt === tries - 1) break;
      const backoff = Math.min(capMs, baseMs * 2 ** attempt);
      await sleep(Math.random() * backoff); // full jitter
    }
  }
  throw lastErr;
}
