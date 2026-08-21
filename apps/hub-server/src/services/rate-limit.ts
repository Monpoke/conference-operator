/**
 * Limiteur de débit en mémoire (seau à jetons).
 *
 * En mémoire parce que le hub tourne en instance unique — même raison qui a
 * permis de supprimer Redis pour le fanout. Le compteur repart à zéro à un
 * redémarrage, ce qui est acceptable : il protège d'un flux soutenu, pas d'un
 * attaquant déterminé.
 */
export interface RateLimitOptions {
  /** Jetons disponibles à plein. */
  capacity: number
  /** Jetons regagnés par seconde. */
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

  /** `true` si l'action est autorisée, et consomme un jeton. */
  take(key: string): boolean {
    const now = this.options.now?.() ?? Date.now()
    const bucket = this.buckets.get(key) ?? { tokens: this.options.capacity, updatedAt: now }

    const gagnes = ((now - bucket.updatedAt) / 1000) * this.options.refillPerSecond
    bucket.tokens = Math.min(this.options.capacity, bucket.tokens + gagnes)
    bucket.updatedAt = now

    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket)
      return false
    }

    bucket.tokens -= 1
    this.buckets.set(key, bucket)
    return true
  }

  /** Évite que la table grossisse indéfiniment sur un événement public. */
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
