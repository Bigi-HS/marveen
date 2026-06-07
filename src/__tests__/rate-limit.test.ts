import { describe, it, expect } from 'vitest'
import { createRateLimiter } from '../web/rate-limit.js'

// A controllable clock so refill/prune are deterministic without timers.
function fakeClock(start = 0) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => { t += ms },
  }
}

describe('createRateLimiter', () => {
  it('allows requests up to capacity then denies', () => {
    const clock = fakeClock()
    const rl = createRateLimiter({ capacity: 3, refillPerSec: 1, now: clock.now })

    expect(rl.allow('ip').allowed).toBe(true)
    expect(rl.allow('ip').allowed).toBe(true)
    expect(rl.allow('ip').allowed).toBe(true)

    const denied = rl.allow('ip')
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfterMs).toBeGreaterThan(0)
  })

  it('tracks each key independently', () => {
    const clock = fakeClock()
    const rl = createRateLimiter({ capacity: 1, refillPerSec: 1, now: clock.now })

    expect(rl.allow('a').allowed).toBe(true)
    expect(rl.allow('a').allowed).toBe(false)
    // A different key still has a full bucket.
    expect(rl.allow('b').allowed).toBe(true)
  })

  it('refills tokens over time via the injected clock', () => {
    const clock = fakeClock()
    const rl = createRateLimiter({ capacity: 2, refillPerSec: 2, now: clock.now })

    expect(rl.allow('ip').allowed).toBe(true)
    expect(rl.allow('ip').allowed).toBe(true)
    expect(rl.allow('ip').allowed).toBe(false)

    // 2 tokens/sec -> one token back after 500ms.
    clock.advance(500)
    expect(rl.allow('ip').allowed).toBe(true)
    expect(rl.allow('ip').allowed).toBe(false)
  })

  it('never refills beyond capacity', () => {
    const clock = fakeClock()
    const rl = createRateLimiter({ capacity: 2, refillPerSec: 10, now: clock.now })

    expect(rl.allow('ip').allowed).toBe(true)
    // Idle long enough to (over)refill; bucket caps at capacity.
    clock.advance(60_000)
    expect(rl.allow('ip').allowed).toBe(true)
    expect(rl.allow('ip').allowed).toBe(true)
    expect(rl.allow('ip').allowed).toBe(false)
  })

  it('reports a retryAfterMs that matches the refill rate', () => {
    const clock = fakeClock()
    const rl = createRateLimiter({ capacity: 1, refillPerSec: 1, now: clock.now })

    expect(rl.allow('ip').allowed).toBe(true)
    const denied = rl.allow('ip')
    expect(denied.allowed).toBe(false)
    // 1 token/sec -> ~1000ms until the next token.
    expect(denied.retryAfterMs).toBe(1000)
  })

  it('prunes only buckets idle beyond the TTL', () => {
    const clock = fakeClock()
    const rl = createRateLimiter({ capacity: 5, refillPerSec: 1, now: clock.now, idleTtlMs: 1000 })

    rl.allow('old')
    clock.advance(500)
    rl.allow('fresh')
    expect(rl.size()).toBe(2)

    // Advance so 'old' is idle 1000ms but 'fresh' only 500ms.
    clock.advance(500)
    const removed = rl.prune()
    expect(removed).toBe(1)
    expect(rl.size()).toBe(1)
    // The surviving key is the freshly-touched one.
    expect(rl.allow('fresh').allowed).toBe(true)
  })

  it('prune is a no-op when nothing is idle', () => {
    const clock = fakeClock()
    const rl = createRateLimiter({ capacity: 5, refillPerSec: 1, now: clock.now, idleTtlMs: 1000 })
    rl.allow('a')
    rl.allow('b')
    expect(rl.prune()).toBe(0)
    expect(rl.size()).toBe(2)
  })
})
