// Dependency-free in-memory per-key token-bucket rate limiter.
//
// The dashboard is tailnet-only and driven by a single operator, so this is
// defence-in-depth (token brute-force + accidental DoS), not a public-scale
// concern. Each key (client IP) gets its own bucket: it starts full at
// `capacity` and refills at `refillPerSec`. Every allowed request spends one
// token; when the bucket is empty the request is denied and we report how long
// until the next token is available.
//
// Pure and time-injectable: callers may pass a `now()` so tests can advance the
// clock deterministically without timers. Idle buckets are pruned periodically
// to bound memory under a churn of distinct keys.

export interface RateLimiterOptions {
  /** Maximum burst -- the number of tokens a freshly-seen key starts with. */
  capacity: number
  /** Steady-state refill rate in tokens per second. */
  refillPerSec: number
  /** Injectable clock (ms epoch). Defaults to Date.now. */
  now?: () => number
  /**
   * A bucket untouched for at least this many ms is eligible for pruning.
   * Defaults to a generous window so a key that is merely between requests is
   * never dropped mid-burst. Must be >= the time to fully refill.
   */
  idleTtlMs?: number
}

export interface RateLimitResult {
  allowed: boolean
  /** When denied, ms until at least one token is available again. */
  retryAfterMs: number
}

interface Bucket {
  /** Fractional token count, capped at `capacity`. */
  tokens: number
  /** Last time (ms) the bucket was refilled/touched. */
  updatedAt: number
}

export interface RateLimiter {
  /** Spend one token for `key`; returns whether it was allowed. */
  allow(key: string): RateLimitResult
  /** Drop buckets idle for longer than `idleTtlMs`. Returns count removed. */
  prune(): number
  /** Current number of tracked buckets (for tests/introspection). */
  size(): number
}

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const capacity = opts.capacity
  const refillPerMs = opts.refillPerSec / 1000
  const now = opts.now ?? Date.now
  // Default the idle TTL to whichever is larger: 5 minutes, or twice the time
  // it takes to refill from empty to full. Guarantees a bucket is never pruned
  // while it could still be rate-limiting an active caller.
  const fullRefillMs = refillPerMs > 0 ? capacity / refillPerMs : Infinity
  const idleTtlMs = opts.idleTtlMs ?? Math.max(5 * 60 * 1000, Math.min(fullRefillMs * 2, 60 * 60 * 1000))

  const buckets = new Map<string, Bucket>()

  function allow(key: string): RateLimitResult {
    const t = now()
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { tokens: capacity, updatedAt: t }
      buckets.set(key, bucket)
    } else {
      const elapsed = t - bucket.updatedAt
      if (elapsed > 0) {
        bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs)
        bucket.updatedAt = t
      }
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return { allowed: true, retryAfterMs: 0 }
    }

    // Empty: report ms until the bucket holds a whole token again.
    const deficit = 1 - bucket.tokens
    const retryAfterMs = refillPerMs > 0 ? Math.ceil(deficit / refillPerMs) : Infinity
    return { allowed: false, retryAfterMs }
  }

  function prune(): number {
    const t = now()
    let removed = 0
    for (const [key, bucket] of buckets) {
      if (t - bucket.updatedAt >= idleTtlMs) {
        buckets.delete(key)
        removed++
      }
    }
    return removed
  }

  function size(): number {
    return buckets.size
  }

  return { allow, prune, size }
}
