import type { ImapFlow } from "imapflow";
import { z } from "zod";
import { formatMailError } from "./validator.js";
import { HttpError } from "../util.js";

/** One mark-read call. Locators are the opaque ids returned by the read API. */
export const MARK_READ_MAX_IDS = 100;

const markReadBody = z.object({
  ids: z.array(z.string().min(1).max(4096)).min(1).max(MARK_READ_MAX_IDS),
  read: z.boolean().optional(),
});

export function parseMarkReadBody(input: unknown): { ids: string[]; read: boolean } {
  const body = markReadBody.parse(input);
  return { ids: body.ids, read: body.read ?? true };
}

export interface MessageLocator {
  connectionId: string;
  folder: string;
  uid: number;
  uidValidity: number;
}

export interface SeenItem {
  id: string;
  folder: string;
  uid: number;
  uidValidity: number;
}

export interface FlagFailure {
  id: string;
  error: string;
  code: "gone" | "not_found" | "forbidden" | "upstream_error";
}

export interface FlagWriteResult {
  updated: string[];
  failed: FlagFailure[];
}

export interface SentSaveResult {
  saved: boolean;
  folder: string | null;
  error?: string;
}

interface FlagMailbox {
  getMailboxLock(path: string): Promise<{ release(): void }>;
  readonly mailbox: false | { uidValidity: bigint | number };
  search(query: { uid: string }, options?: { uid?: boolean }): Promise<number[] | false>;
  messageFlagsAdd(range: number[], flags: string[], options?: { uid?: boolean }): Promise<unknown>;
  messageFlagsRemove(range: number[], flags: string[], options?: { uid?: boolean }): Promise<unknown>;
}

interface SentMailbox {
  list(): Promise<Array<{ path: string; name: string; specialUse?: string; flags?: Set<string> }>>;
  append(path: string, content: Buffer, flags?: string[]): Promise<unknown>;
}

const SENT_NAMES = new Set(["sent", "sent items", "sent messages", "sent mail"]);

/**
 * Group opaque message ids by mailbox and write `\Seen` (the flag the read path
 * uses for `is_unread`). One bad id does not fail the rest of the batch.
 * Duplicate ids are applied once.
 */
export async function markMessages<T extends { status: string }>(opts: {
  ids: string[];
  read: boolean;
  decode: (id: string) => MessageLocator;
  load: (connectionId: string) => Promise<T>;
  apply: (connection: T, connectionId: string, items: SeenItem[], read: boolean) => Promise<FlagWriteResult>;
}): Promise<FlagWriteResult> {
  const failed: FlagFailure[] = [];
  const pending: { id: string; loc: MessageLocator }[] = [];
  const seen = new Set<string>();
  for (const id of opts.ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      pending.push({ id, loc: opts.decode(id) });
    } catch (err) {
      failed.push({
        id,
        error: err instanceof HttpError ? err.message : "Malformed message id",
        code: "gone",
      });
    }
  }

  const groups = new Map<string, SeenItem[]>();
  for (const item of pending) {
    const list = groups.get(item.loc.connectionId) ?? [];
    list.push({
      id: item.id,
      folder: item.loc.folder,
      uid: item.loc.uid,
      uidValidity: item.loc.uidValidity,
    });
    groups.set(item.loc.connectionId, list);
  }

  const updated: string[] = [];
  for (const [connectionId, items] of groups) {
    let connection: T;
    try {
      connection = await opts.load(connectionId);
    } catch (err) {
      const message = err instanceof HttpError ? err.message : "Connection not found";
      const code: FlagFailure["code"] = err instanceof HttpError && err.status === 403 ? "forbidden" : "not_found";
      for (const item of items) failed.push({ id: item.id, error: message, code });
      continue;
    }
    if (connection.status === "paused") {
      for (const item of items) failed.push({ id: item.id, error: "Connection is paused", code: "forbidden" });
      continue;
    }
    try {
      const result = await opts.apply(connection, connectionId, items, opts.read);
      updated.push(...result.updated);
      failed.push(...result.failed);
    } catch (err) {
      const message = err instanceof HttpError ? err.message : formatMailError(err);
      for (const item of items) {
        if (updated.includes(item.id) || failed.some((failure) => failure.id === item.id)) continue;
        failed.push({ id: item.id, error: message, code: "upstream_error" });
      }
    }
  }

  const order = new Map<string, number>();
  opts.ids.forEach((id, index) => {
    if (!order.has(id)) order.set(id, index);
  });
  const rank = (id: string) => order.get(id) ?? 0;
  updated.sort((a, b) => rank(a) - rank(b));
  failed.sort((a, b) => rank(a.id) - rank(b.id));
  return { updated, failed };
}

/** Set or clear `\Seen` on an already-connected IMAP client. */
export async function setSeenWithClient(client: FlagMailbox, items: SeenItem[], seen: boolean): Promise<FlagWriteResult> {
  const updated: string[] = [];
  const failed: FlagFailure[] = [];
  const byFolder = new Map<string, SeenItem[]>();
  for (const item of items) {
    const list = byFolder.get(item.folder) ?? [];
    list.push(item);
    byFolder.set(item.folder, list);
  }

  for (const [folder, folderItems] of byFolder) {
    let lock: { release(): void } | undefined;
    const pending = new Set(folderItems.map((item) => item.id));
    try {
      lock = await client.getMailboxLock(folder);
      const mailbox = client.mailbox;
      if (!mailbox) {
        for (const item of folderItems) {
          failed.push({ id: item.id, error: "Mailbox could not be opened", code: "upstream_error" });
          pending.delete(item.id);
        }
        continue;
      }
      const uidValidity = Number(mailbox.uidValidity);
      const fresh = folderItems.filter((item) => {
        if (item.uidValidity === uidValidity) return true;
        failed.push({ id: item.id, error: "Message locator is stale; re-query", code: "gone" });
        pending.delete(item.id);
        return false;
      });
      if (fresh.length === 0) continue;

      let existing: Set<number> | null = null;
      try {
        const found = await client.search({ uid: fresh.map((item) => item.uid).join(",") }, { uid: true });
        existing = new Set(found || []);
      } catch {
        // Some hosts reject UID SEARCH. STORE is idempotent, so attempt it anyway.
        existing = null;
      }
      const present = fresh.filter((item) => {
        if (existing === null || existing.has(item.uid)) return true;
        failed.push({ id: item.id, error: "Message no longer exists", code: "gone" });
        pending.delete(item.id);
        return false;
      });
      if (present.length === 0) continue;
      const uids = present.map((item) => item.uid);
      if (seen) await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
      else await client.messageFlagsRemove(uids, ["\\Seen"], { uid: true });
      for (const item of present) {
        updated.push(item.id);
        pending.delete(item.id);
      }
    } catch (err) {
      for (const id of pending) {
        if (updated.includes(id) || failed.some((failure) => failure.id === id)) continue;
        failed.push({ id, error: formatMailError(err), code: "upstream_error" });
      }
    } finally {
      lock?.release();
    }
  }

  return { updated, failed };
}

/**
 * Append the exact bytes that were sent into the mailbox's Sent folder.
 * Prefers the IMAP `\Sent` special-use flag, then common folder names.
 * Failure is reported and does not throw — the SMTP send already happened.
 */
export async function saveSentWithClient(client: SentMailbox, raw: Buffer): Promise<SentSaveResult> {
  try {
    const boxes = await client.list();
    const special = boxes.find((box) => box.specialUse === "\\Sent" || box.flags?.has("\\Sent"));
    const named = boxes.find((box) => {
      const name = box.name.toLowerCase();
      const path = box.path.toLowerCase();
      return SENT_NAMES.has(name) || SENT_NAMES.has(path) || path.endsWith("/sent") || path.endsWith(".sent");
    });
    const folder = special?.path ?? named?.path ?? null;
    if (!folder) return { saved: false, folder: null, error: "No Sent folder on this mailbox" };
    await client.append(folder, raw, ["\\Seen"]);
    return { saved: true, folder };
  } catch (err) {
    return { saved: false, folder: null, error: formatMailError(err) };
  }
}

export function asFlagMailbox(client: ImapFlow): FlagMailbox {
  return client;
}

export function asSentMailbox(client: ImapFlow): SentMailbox {
  return client;
}
