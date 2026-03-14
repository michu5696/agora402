/**
 * Simple TTL cache for trust scores.
 *
 * Avoids re-querying 4 sources for the same address within a short window.
 * LRU eviction keeps memory bounded.
 */
export interface CacheOptions {
  /** Time-to-live in milliseconds (default: 60000 = 1 minute) */
  ttlMs?: number;
  /** Maximum entries (default: 1000) */
  maxSize?: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private readonly cache = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(options?: CacheOptions) {
    this.ttlMs = options?.ttlMs ?? 60_000;
    this.maxSize = options?.maxSize ?? 1000;
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    // Evict oldest entries if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
