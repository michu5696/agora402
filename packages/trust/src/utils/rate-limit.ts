/**
 * Simple sliding-window rate limiter.
 *
 * Tracks requests per IP/key within a time window.
 * Used on /trust endpoint to prevent DoS.
 */
export interface RateLimitOptions {
  /** Max requests per window (default: 100) */
  maxRequests?: number;
  /** Window size in milliseconds (default: 60000 = 1 minute) */
  windowMs?: number;
}

interface RateLimitEntry {
  timestamps: number[];
}

export class RateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(options?: RateLimitOptions) {
    this.maxRequests = options?.maxRequests ?? 100;
    this.windowMs = options?.windowMs ?? 60_000;

    // Periodic cleanup of stale entries
    this.cleanupInterval = setInterval(() => this.cleanup(), this.windowMs * 2);
    // Don't prevent process exit
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Check if a request is allowed.
   * Returns { allowed: true } or { allowed: false, retryAfterMs }.
   */
  check(key: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let entry = this.entries.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.entries.set(key, entry);
    }

    // Remove timestamps outside the window
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

    if (entry.timestamps.length >= this.maxRequests) {
      const oldestInWindow = entry.timestamps[0];
      const retryAfterMs = oldestInWindow + this.windowMs - now;
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1000) };
    }

    entry.timestamps.push(now);
    return { allowed: true };
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, entry] of this.entries) {
      entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
      if (entry.timestamps.length === 0) {
        this.entries.delete(key);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.entries.clear();
  }
}
