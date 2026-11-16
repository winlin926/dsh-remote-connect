/** In-memory token-bucket rate limiting, keyed per bucket and identity. */

export interface BucketRule {
  ratePerSecond: number
  burst: number
}

interface BucketState {
  tokens: number
  updatedAt: number
}

export interface RateLimitDecision {
  allowed: boolean
  retryAfterMs: number
}

const MAX_ENTRIES = 20_000
const STALE_MS = 10 * 60_000

/** One limiter instance owns every named bucket of a process. */
export class RateLimiter {
  private readonly buckets = new Map<string, BucketState>()
  private lastSweep = 0

  /**
   * Consume one token from `bucket:key`. Returns whether the request is
   * allowed and, when refused, the delay until the next token.
   */
  take(bucket: string, key: string, rule: BucketRule, now = Date.now()): RateLimitDecision {
    this.sweep(now)
    const id = `${bucket}\0${key}`
    const state = this.buckets.get(id) ?? { tokens: rule.burst, updatedAt: now }
    const elapsedSeconds = Math.max(0, now - state.updatedAt) / 1_000
    const tokens = Math.min(rule.burst, state.tokens + elapsedSeconds * rule.ratePerSecond)
    if (tokens < 1) {
      const deficit = 1 - tokens
      const retryAfterMs = Math.max(1, Math.ceil((deficit / rule.ratePerSecond) * 1_000))
      this.buckets.set(id, { tokens, updatedAt: now })
      return { allowed: false, retryAfterMs }
    }
    this.buckets.set(id, { tokens: tokens - 1, updatedAt: now })
    return { allowed: true, retryAfterMs: 0 }
  }

  private sweep(now: number): void {
    if (this.buckets.size < MAX_ENTRIES || now - this.lastSweep < STALE_MS) return
    this.lastSweep = now
    for (const [id, state] of this.buckets) {
      if (now - state.updatedAt > STALE_MS) this.buckets.delete(id)
    }
  }
}
