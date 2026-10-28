import type { ImapFlow, SearchObject } from "imapflow";
import { buildClient, formatMailError, type ConnCfg } from "./validator.js";
import { MAX_MESSAGE_BYTES, readAttachment, type AttachmentFile } from "./attachments.js";
import { normalizeMessage, type UnifiedMessage } from "./normalize.js";
import { payloadTooLarge, withRetry, upstream, gone } from "../util.js";
import {
  asFlagMailbox,
  asSentMailbox,
  saveSentWithClient,
  setSeenWithClient,
  type FlagWriteResult,
  type SeenItem,
  type SentSaveResult,
} from "./flags.js";

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
  /** Free text: IMAP TEXT, which matches headers (subject included) and body. Server-side, best effort. */
  text?: string;
  limit: number;
}

/** Map the API filters onto one IMAP SEARCH (all criteria ANDed). */
export function buildSearchCriteria(q: SearchQuery): SearchObject {
  const criteria: SearchObject = { since: q.since };
  if (q.unread) criteria.seen = false;
  if (q.from) criteria.from = q.from;
  if (q.subject) criteria.subject = q.subject;
  if (q.text) criteria.text = q.text;
  return criteria;
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

async function withClient<T>(t: FetchTarget, fn: (c: ImapFlow) => Promise<T>, opts?: { tries?: number }): Promise<T> {
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
    }, { tries: opts?.tries ?? 3 }),
  );
}

export interface Candidate {
  message: UnifiedMessage;
  uid: number;
}

export interface ConnPage {
  uidValidity: number;
  candidates: Candidate[];
}

/**
 * Live SEARCH + FETCH the newest matching page of INBOX for one connection.
 * Keyset paging: `afterUid` caps to messages older than this connection's cursor
 * boundary. If the mailbox's uidvalidity changed since the cursor was issued, the
 * boundary is ignored (restart this connection from the newest). Assumes UID order
 * ~= arrival order within a mailbox (true for normal INBOXes).
 */
export async function searchAndFetch(
  t: FetchTarget,
  q: SearchQuery,
  opts: { afterUid?: number; expectUidValidity?: number } = {},
): Promise<ConnPage> {
  return withClient(t, async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const mailbox = client.mailbox;
      if (!mailbox) throw upstream("INBOX could not be opened");
      const uidValidity = Number(mailbox.uidValidity);
      const ceiling =
        opts.expectUidValidity !== undefined && opts.expectUidValidity !== uidValidity ? undefined : opts.afterUid;

      let uids = (await client.search(buildSearchCriteria(q), { uid: true })) || [];
      uids.sort((x, y) => x - y); // ascending; uid asc ~= arrival asc
      if (ceiling !== undefined) uids = uids.filter((u) => u < ceiling);
      const page = uids.slice(-q.limit).reverse(); // newest `limit`, newest first

      const candidates: Candidate[] = [];
      for await (const msg of client.fetch(page, { uid: true, source: true, flags: true }, { uid: true })) {
        if (!msg.source) continue;
        candidates.push({
          uid: msg.uid,
          message: await normalizeMessage(msg.source, {
            connectionId: t.connectionId,
            sourceAccount: t.sourceAccount,
            provider: t.provider,
            folder: "INBOX",
            uid: msg.uid,
            uidValidity,
            isUnread: !msg.flags?.has("\\Seen"),
          }),
        });
      }
      return { uidValidity, candidates };
    } finally {
      lock.release();
    }
  });
}

/** Write the IMAP `\Seen` flag (the same flag `is_unread` is derived from). Idempotent, so retries are safe. */
export async function setSeen(t: FetchTarget, items: SeenItem[], seen: boolean): Promise<FlagWriteResult> {
  return withClient(t, (client) => setSeenWithClient(asFlagMailbox(client), items, seen));
}

/**
 * File the sent RFC822 bytes in the Sent folder. A single attempt: retrying an append
 * the server stored but we failed to observe would save a second copy.
 */
export async function appendToSent(t: FetchTarget, raw: Buffer): Promise<SentSaveResult> {
  return withClient(t, (client) => saveSentWithClient(asSentMailbox(client), raw), { tries: 1 });
}

/**
 * Live-fetch one attachment. The RFC822 source is read from IMAP for this request
 * and dropped when the handler returns; nothing is written to the database.
 * `index` matches `attachments[].index` on the normalized message.
 */
export async function fetchAttachment(
  t: FetchTarget,
  folder: string,
  uid: number,
  uidValidity: number,
  index: number,
): Promise<AttachmentFile> {
  return withClient(t, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const mailbox = client.mailbox;
      if (!mailbox) throw gone();
      if (Number(mailbox.uidValidity) !== uidValidity) throw gone();
      const meta = await client.fetchOne(String(uid), { uid: true, size: true }, { uid: true });
      if (!meta) throw gone();
      if (typeof meta.size === "number" && meta.size > MAX_MESSAGE_BYTES) {
        throw payloadTooLarge(`Message is ${meta.size} bytes; attachment download is limited to ${MAX_MESSAGE_BYTES} bytes`);
      }
      const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
      if (!msg || !msg.source) throw gone();
      return readAttachment(msg.source, index);
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
      const mailbox = client.mailbox;
      if (!mailbox) throw gone();
      if (Number(mailbox.uidValidity) !== uidValidity) throw gone();
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
