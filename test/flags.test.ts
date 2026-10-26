import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ZodError } from "zod";
import "./block-network.js";
import { TtlCache } from "../src/cache/lru.js";
import { gone, notFound, upstream } from "../src/util.js";
import {
  MARK_READ_MAX_IDS,
  markMessages,
  parseMarkReadBody,
  saveSentWithClient,
  setSeenWithClient,
  type SeenItem,
} from "../src/imap/flags.js";

class FakeImap {
  locks: string[] = [];
  released: string[] = [];
  added: number[][] = [];
  removed: number[][] = [];
  uidValidity = 10n;
  missing = new Set<number>();
  failStore = false;
  mailbox: { uidValidity: bigint } | false = { uidValidity: 10n };

  async getMailboxLock(path: string) {
    this.locks.push(path);
    this.mailbox = { uidValidity: this.uidValidity };
    return { release: () => { this.released.push(path); } };
  }

  async search(query: { uid: string }) {
    return query.uid
      .split(",")
      .map((uid) => Number(uid))
      .filter((uid) => !this.missing.has(uid));
  }

  async messageFlagsAdd(range: number[], flags: string[]) {
    assert.deepEqual(flags, ["\\Seen"]);
    if (this.failStore) throw new Error("connection timed out");
    this.added.push([...range]);
    return true;
  }

  async messageFlagsRemove(range: number[], flags: string[]) {
    assert.deepEqual(flags, ["\\Seen"]);
    this.removed.push([...range]);
    return true;
  }
}

function item(id: string, overrides: Partial<SeenItem> = {}): SeenItem {
  return { id, folder: "INBOX", uid: 1, uidValidity: 10, ...overrides };
}

describe("parseMarkReadBody", () => {
  it("defaults to marking read and rejects empty or oversized batches", () => {
    assert.deepEqual(parseMarkReadBody({ ids: ["abc"] }), { ids: ["abc"], read: true });
    assert.equal(parseMarkReadBody({ ids: ["abc"], read: false }).read, false);
    assert.throws(() => parseMarkReadBody({ ids: [] }), ZodError);
    assert.throws(() => parseMarkReadBody({ ids: Array.from({ length: MARK_READ_MAX_IDS + 1 }, (_, i) => `id-${i}`) }), ZodError);
  });
});

describe("setSeenWithClient", () => {
  it("adds \\Seen for read and removes it for unread", async () => {
    const client = new FakeImap();
    const read = await setSeenWithClient(client, [item("a", { uid: 4 }), item("b", { uid: 9 })], true);
    assert.deepEqual(read.updated, ["a", "b"]);
    assert.deepEqual(read.failed, []);
    assert.deepEqual(client.added, [[4, 9]]);
    assert.deepEqual(client.released, ["INBOX"]);

    const unread = await setSeenWithClient(client, [item("a", { uid: 4 })], false);
    assert.deepEqual(unread.updated, ["a"]);
    assert.deepEqual(client.removed, [[4]]);
  });

  it("reports stale locators and missing messages without storing flags", async () => {
    const client = new FakeImap();
    client.missing.add(8);
    const result = await setSeenWithClient(
      client,
      [item("stale", { uid: 3, uidValidity: 2 }), item("gone", { uid: 8 }), item("ok", { uid: 5 })],
      true,
    );
    assert.deepEqual(result.updated, ["ok"]);
    assert.deepEqual(result.failed.map((failure) => failure.code), ["gone", "gone"]);
    assert.deepEqual(client.added, [[5]]);
    assert.deepEqual(client.released, ["INBOX"]);
  });

  it("releases the mailbox lock when the store fails", async () => {
    const client = new FakeImap();
    client.failStore = true;
    const result = await setSeenWithClient(client, [item("a", { uid: 1 }), item("b", { folder: "Archive", uid: 2 })], true);
    assert.equal(result.updated.length, 0);
    assert.equal(result.failed.length, 2);
    assert.deepEqual(result.failed.map((failure) => failure.code), ["upstream_error", "upstream_error"]);
    assert.deepEqual(client.released.sort(), ["Archive", "INBOX"]);
  });
});

describe("markMessages", () => {
  it("keeps going when one id is bad, one mailbox is paused, and another is missing", async () => {
    const applied: string[] = [];
    const result = await markMessages({
      ids: ["bad", "ok", "ok", "paused", "missing"],
      read: false,
      decode(id) {
        if (id === "bad") throw gone("Malformed message id");
        if (id === "paused") return { connectionId: "paused", folder: "INBOX", uid: 2, uidValidity: 1 };
        if (id === "missing") return { connectionId: "missing", folder: "INBOX", uid: 3, uidValidity: 1 };
        return { connectionId: "c1", folder: "INBOX", uid: 1, uidValidity: 1 };
      },
      async load(connectionId) {
        if (connectionId === "missing") throw notFound("Connection not found");
        return { status: connectionId === "paused" ? "paused" : "active" };
      },
      async apply(_connection, connectionId, items, read) {
        assert.equal(read, false);
        assert.equal(connectionId, "c1");
        applied.push(...items.map((item) => item.id));
        return { updated: items.map((item) => item.id), failed: [] };
      },
    });

    assert.deepEqual(applied, ["ok"]);
    assert.deepEqual(result.updated, ["ok"]);
    assert.deepEqual(
      result.failed.map((failure) => [failure.id, failure.code]),
      [
        ["bad", "gone"],
        ["paused", "forbidden"],
        ["missing", "not_found"],
      ],
    );
  });

  it("reports an upstream failure for the mailbox that threw", async () => {
    const result = await markMessages({
      ids: ["a"],
      read: true,
      decode: () => ({ connectionId: "c1", folder: "INBOX", uid: 1, uidValidity: 1 }),
      load: async () => ({ status: "active" }),
      apply: async () => {
        throw upstream("Connection timed out. Check the host, port, and network reachability.");
      },
    });
    assert.deepEqual(result.updated, []);
    assert.equal(result.failed[0]?.code, "upstream_error");
    assert.match(result.failed[0]?.error ?? "", /timed out/i);
  });
});

describe("saveSentWithClient", () => {
  it("prefers the \\Sent special-use folder and appends the same bytes", async () => {
    let appended: { path: string; flags?: string[]; size: number } | undefined;
    const saved = await saveSentWithClient(
      {
        async list() {
          return [
            { path: "INBOX", name: "INBOX" },
            { path: "Sent Items", name: "Sent Items", specialUse: "\\Sent" },
            { path: "Sent", name: "Sent" },
          ];
        },
        async append(path, content, flags) {
          appended = { path, flags, size: content.length };
          return { uid: 1 };
        },
      },
      Buffer.from("raw-message"),
    );
    assert.equal(saved.saved, true);
    assert.equal(saved.folder, "Sent Items");
    assert.equal(appended?.path, "Sent Items");
    assert.deepEqual(appended?.flags, ["\\Seen"]);
    assert.equal(appended?.size, Buffer.byteLength("raw-message"));
  });

  it("falls back to a common Sent name", async () => {
    const saved = await saveSentWithClient(
      {
        async list() {
          return [{ path: "INBOX.Sent", name: "Sent" }];
        },
        async append() {
          return true;
        },
      },
      Buffer.from("raw"),
    );
    assert.equal(saved.saved, true);
    assert.equal(saved.folder, "INBOX.Sent");
  });

  it("does not throw when the mailbox has no Sent folder or the append fails", async () => {
    const missing = await saveSentWithClient(
      {
        async list() {
          return [{ path: "INBOX", name: "INBOX" }];
        },
        async append() {
          throw new Error("should not append");
        },
      },
      Buffer.from("raw"),
    );
    assert.equal(missing.saved, false);
    assert.equal(missing.folder, null);
    assert.match(missing.error ?? "", /No Sent folder/);

    const failed = await saveSentWithClient(
      {
        async list() {
          return [{ path: "Sent", name: "Sent", specialUse: "\\Sent" }];
        },
        async append() {
          throw new Error("Connection refused");
        },
      },
      Buffer.from("raw"),
    );
    assert.equal(failed.saved, false);
    assert.match(failed.error ?? "", /Connection refused|port/i);
  });
});

describe("message cache", () => {
  it("drops only the tenant whose flags changed", () => {
    const cache = new TtlCache<string>(60_000);
    cache.set("tenant-a:query", "a");
    cache.set("tenant-b:query", "b");
    cache.deletePrefix("tenant-a:");
    assert.equal(cache.get("tenant-a:query"), undefined);
    assert.equal(cache.get("tenant-b:query"), "b");
  });
});
