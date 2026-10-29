/**
 * Per-address token bucket, in memory.
 *
 * A copy of the hub's (`apps/hub-server/src/services/rate-limit.ts`): the apps
 * share no code by import. One replica, so memory is enough; a restart forgets,
 * which is fine — it guards against a sustained flow, not a determined attacker.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>()

  constructor(private readonly options: { capacity: number; refillPerSecond: number; now?: () => number }) {}

  take(key: string): boolean {
    const now = this.options.now?.() ?? Date.now()
    const bucket = this.buckets.get(key) ?? { tokens: this.options.capacity, updatedAt: now }
    bucket.tokens = Math.min(this.options.capacity, bucket.tokens + ((now - bucket.updatedAt) / 1000) * this.options.refillPerSecond)
    bucket.updatedAt = now
    this.buckets.set(key, bucket)
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }

  /** Forgets the addresses gone quiet: a public page meets many. */
  prune(maxAgeMs = 10 * 60_000): void {
    const now = this.options.now?.() ?? Date.now()
    for (const [key, bucket] of this.buckets) if (now - bucket.updatedAt > maxAgeMs) this.buckets.delete(key)
  }
}
