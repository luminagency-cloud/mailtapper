/**
 * Thin in-memory TTL cache (single-node v1). A performance buffer ONLY — wipeable
 * at any instant with zero data loss, because the mailbox is the source of truth.
 * Swap for Redis/Postgres if we ever run multiple `api` nodes.
 */
type Entry<V> = { value: V; expiresAt: number };

export class TtlCache<V = unknown> {
  private store = new Map<string, Entry<V>>();
  constructor(private defaultTtlMs: number, private maxEntries = 5000) {}

  get(key: string): V | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // refresh LRU recency
    this.store.delete(key);
    this.store.set(key, e);
    return e.value;
  }

  set(key: string, value: V, ttlMs = this.defaultTtlMs): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /** Drop every entry whose key starts with `prefix` (used after a mailbox write). */
  deletePrefix(prefix: string): void {
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  clear(): void {
    this.store.clear();
  }
}
