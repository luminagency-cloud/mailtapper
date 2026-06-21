import type { ImapFlow } from "imapflow";
import { buildClient, formatMailError, type ConnCfg } from "./validator.js";
import { normalizeMessage, type UnifiedMessage } from "./normalize.js";
import { withRetry, upstream, gone } from "../util.js";

export interface FetchTarget extends ConnCfg {
  connectionId: string;
  sourceAccount: string;
  provider: string;
  password: string;
}

export interface SearchQuery {
  since: Date;
  from?: string;
  unread?: boolean;
  subject?: string;
  limit: number;
}

/**
 * Connection-hygiene layer. Per-host concurrency gate so we never open a storm of
 * sockets at one server (the thing that triggers timeouts/bans on flaky long-tail
 * hosts). Connections are opened per call for now; a reusing pool is a v1.x
 * optimization — TODO.
 */
const HOST_MAX = 3;
const hostInFlight = new Map<string, number>();

async function withHostSlot<T>(host: string, fn: () => Promise<T>): Promise<T> {
  while ((hostInFlight.get(host) ?? 0) >= HOST_MAX) await new Promise((r) => setTimeout(r, 50));
  hostInFlight.set(host, (hostInFlight.get(host) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    hostInFlight.set(host, (hostInFlight.get(host) ?? 1) - 1);
  }
}

async function withClient<T>(t: FetchTarget, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  return withHostSlot(t.host, () =>
    withRetry(async () => {
      const client = buildClient(t, t.password);
      try {
        await client.connect();
        return await fn(client);
      } catch (err) {
        if ((err as { status?: number }).status) throw err; // already an HttpError (e.g. 410)
        throw upstream(formatMailError(err));
      } finally {
        try {
          await client.logout();
        } catch {
          /* ignore */
        }
      }
    }),
  );
}

/** Live SEARCH + FETCH the newest matching page of INBOX, normalized. */
export async function searchAndFetch(t: FetchTarget, q: SearchQuery): Promise<UnifiedMessage[]> {
  return withClient(t, async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uidValidity = Number((client.mailbox as { uidValidity: number }).uidValidity);
      const criteria: Record<string, unknown> = { since: q.since };
      if (q.unread) criteria.seen = false;
      if (q.from) criteria.from = q.from;
      if (q.subject) criteria.subject = q.subject;

      const uids = (await client.search(criteria, { uid: true })) || [];
      const page = uids.slice(-q.limit).reverse(); // newest first
      const out: UnifiedMessage[] = [];
      for await (const msg of client.fetch(page, { uid: true, source: true, flags: true }, { uid: true })) {
        if (!msg.source) continue;
        out.push(
          await normalizeMessage(msg.source, {
            connectionId: t.connectionId,
            sourceAccount: t.sourceAccount,
            provider: t.provider,
            folder: "INBOX",
            uid: msg.uid,
            uidValidity,
            isUnread: !msg.flags?.has("\\Seen"),
          }),
        );
      }
      return out;
    } finally {
      lock.release();
    }
  });
}

/** Re-fetch a single message by its locator (folder, uid, uidvalidity). */
export async function fetchOne(t: FetchTarget, folder: string, uid: number, uidValidity: number): Promise<UnifiedMessage> {
  return withClient(t, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const currentValidity = Number((client.mailbox as { uidValidity: number }).uidValidity);
      if (currentValidity !== uidValidity) throw gone();
      const msg = await client.fetchOne(String(uid), { uid: true, source: true, flags: true }, { uid: true });
      if (!msg || !msg.source) throw gone();
      return normalizeMessage(msg.source, {
        connectionId: t.connectionId,
        sourceAccount: t.sourceAccount,
        provider: t.provider,
        folder,
        uid,
        uidValidity,
        isUnread: !msg.flags?.has("\\Seen"),
      });
    } finally {
      lock.release();
    }
  });
}
