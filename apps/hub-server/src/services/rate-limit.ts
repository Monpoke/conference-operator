/**
 * In-memory rate limiter (token bucket).
 *
 * In memory because the hub runs as a single instance — the same reason that
 * allowed Redis to be dropped for the fanout. The counter resets to zero on a
 * restart, which is acceptable: it protects against a sustained flow, not
 * against a determined attacker.
 */
export interface RateLimitOptions {
  /** Tokens available when full. */
  capacity: number
  /** Tokens regained per second. */
  refillPerSecond: number
  now?: () => number
}

interface Bucket {
  tokens: number
  updatedAt: number
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()

  constructor(private readonly options: RateLimitOptions) {}

  /** `true` if the action is allowed, and consumes a token. */
  take(key: string): boolean {
    const now = this.options.now?.() ?? Date.now()
    const bucket = this.buckets.get(key) ?? { tokens: this.options.capacity, updatedAt: now }

    const gained = ((now - bucket.updatedAt) / 1000) * this.options.refillPerSecond
    bucket.tokens = Math.min(this.options.capacity, bucket.tokens + gained)
    bucket.updatedAt = now

    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket)
      return false
    }

    bucket.tokens -= 1
    this.buckets.set(key, bucket)
    return true
  }

  /** Stops the table from growing indefinitely on a public event. */
  prune(maxAgeMs = 10 * 60_000): void {
    const now = this.options.now?.() ?? Date.now()
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt > maxAgeMs) this.buckets.delete(key)
    }
  }

  get size(): number {
    return this.buckets.size
  }
}
