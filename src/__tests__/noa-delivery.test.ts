import { describe, it, expect } from 'vitest'
import {
  TIER_WEIGHT,
  DEFAULT_WEIGHT,
  priorityWeight,
  HARD_TTL_MS,
  ESCALATE_AFTER_DEFAULT_MS,
  ESCALATE_AFTER_HIGH_MS,
  ESCALATE_AFTER_URGENT_MS,
  BACKSTOP_AFTER_MS,
  BACKSTOP_THROTTLE_MS,
  retryPolicyFor,
  classifyAge,
  orderForDrain,
  planDeliveryTick,
  pruneStaleThrottleState,
  type PendingDelivery,
  type RecipientState,
  type DeliveryStep,
} from '../noa-delivery.js'

// Clean-room delivery core (umbrella f68461a6, B1 PoC slice). These tests are
// the behavioural contract, written before the implementation. The invariants
// they pin down mirror the load-bearing guarantees of the delivery layer
// documented in store/spec-noa-b-orchestration-map.md (B1):
//   - busy recipient = DEFER, never DROP, until the hard-TTL
//   - the hard-TTL is invariant across priorities (priority moves alert timing
//     only, never the give-up)
//   - drain order: priority first, FIFO within a priority
//   - idle-only inject: one delivery per recipient per tick
//   - quiescence backstop: age-gated + per-message throttled pane re-proof

const MIN = 60 * 1000
const HOUR = 60 * MIN

function msg(overrides: Partial<PendingDelivery> & { id: number }): PendingDelivery {
  return {
    from: 'sender',
    to: 'recipient',
    priority: 'normal',
    createdAtMs: 0,
    ...overrides,
  }
}

function ready(): RecipientState {
  return { sessionRunning: true, readyForPrompt: true }
}

function busy(): RecipientState {
  return { sessionRunning: true, readyForPrompt: false }
}

function stepFor(steps: DeliveryStep[], id: number): DeliveryStep {
  const step = steps.find((s) => s.id === id)
  if (!step) throw new Error(`no step for id ${id}`)
  return step
}

// ---------------------------------------------------------------------------
// priorityWeight
// ---------------------------------------------------------------------------

describe('priorityWeight', () => {
  it('maps the four tiers to strictly increasing weights', () => {
    expect(priorityWeight('low')).toBe(TIER_WEIGHT.low)
    expect(priorityWeight('normal')).toBe(TIER_WEIGHT.normal)
    expect(priorityWeight('high')).toBe(TIER_WEIGHT.high)
    expect(priorityWeight('urgent')).toBe(TIER_WEIGHT.urgent)
    expect(TIER_WEIGHT.low).toBeLessThan(TIER_WEIGHT.normal)
    expect(TIER_WEIGHT.normal).toBeLessThan(TIER_WEIGHT.high)
    expect(TIER_WEIGHT.high).toBeLessThan(TIER_WEIGHT.urgent)
  })

  it('passes a finite number through unchanged (granular priorities)', () => {
    expect(priorityWeight(60)).toBe(60)
    expect(priorityWeight(0)).toBe(0)
    expect(priorityWeight(-5)).toBe(-5)
  })

  it('falls back to the normal default for unknown or invalid values', () => {
    expect(priorityWeight(undefined)).toBe(DEFAULT_WEIGHT)
    expect(priorityWeight(null)).toBe(DEFAULT_WEIGHT)
    expect(priorityWeight('critical' as never)).toBe(DEFAULT_WEIGHT)
    expect(priorityWeight(Number.NaN)).toBe(DEFAULT_WEIGHT)
    expect(priorityWeight(Number.POSITIVE_INFINITY)).toBe(DEFAULT_WEIGHT)
  })
})

// ---------------------------------------------------------------------------
// retryPolicyFor
// ---------------------------------------------------------------------------

describe('retryPolicyFor', () => {
  it('escalates urgent at 15 min, high at 30 min, normal/low at 60 min', () => {
    expect(retryPolicyFor('urgent').escalateAfterMs).toBe(ESCALATE_AFTER_URGENT_MS)
    expect(retryPolicyFor('high').escalateAfterMs).toBe(ESCALATE_AFTER_HIGH_MS)
    expect(retryPolicyFor('normal').escalateAfterMs).toBe(ESCALATE_AFTER_DEFAULT_MS)
    expect(retryPolicyFor('low').escalateAfterMs).toBe(ESCALATE_AFTER_DEFAULT_MS)
    expect(ESCALATE_AFTER_URGENT_MS).toBe(15 * MIN)
    expect(ESCALATE_AFTER_HIGH_MS).toBe(30 * MIN)
    expect(ESCALATE_AFTER_DEFAULT_MS).toBe(60 * MIN)
  })

  it('re-alert cadence mirrors the escalate-after window', () => {
    for (const tier of ['low', 'normal', 'high', 'urgent'] as const) {
      const policy = retryPolicyFor(tier)
      expect(policy.reAlertIntervalMs).toBe(policy.escalateAfterMs)
    }
  })

  it('INVARIANT: the hard-TTL is identical for every priority', () => {
    expect(HARD_TTL_MS).toBe(6 * HOUR)
    for (const p of ['low', 'normal', 'high', 'urgent', 0, 100, 9999, undefined] as const) {
      expect(retryPolicyFor(p as never).hardTtlMs).toBe(HARD_TTL_MS)
    }
  })

  it('numeric priorities bucket by threshold (>=100 urgent, >=75 high)', () => {
    expect(retryPolicyFor(100).escalateAfterMs).toBe(ESCALATE_AFTER_URGENT_MS)
    expect(retryPolicyFor(150).escalateAfterMs).toBe(ESCALATE_AFTER_URGENT_MS)
    expect(retryPolicyFor(75).escalateAfterMs).toBe(ESCALATE_AFTER_HIGH_MS)
    expect(retryPolicyFor(99).escalateAfterMs).toBe(ESCALATE_AFTER_HIGH_MS)
    expect(retryPolicyFor(74).escalateAfterMs).toBe(ESCALATE_AFTER_DEFAULT_MS)
    expect(retryPolicyFor(10).escalateAfterMs).toBe(ESCALATE_AFTER_DEFAULT_MS)
  })
})

// ---------------------------------------------------------------------------
// classifyAge
// ---------------------------------------------------------------------------

describe('classifyAge', () => {
  const policy = retryPolicyFor('normal')

  it('is "wait" strictly inside the first escalation window', () => {
    expect(classifyAge(0, undefined, 0, policy)).toBe('wait')
    expect(classifyAge(policy.escalateAfterMs - 1, undefined, 0, policy)).toBe('wait')
  })

  it('is "escalate" at the exact escalate-after boundary (first crossing)', () => {
    expect(classifyAge(policy.escalateAfterMs, undefined, 0, policy)).toBe('escalate')
  })

  it('is "expired" at the exact hard-TTL boundary, and expiry beats escalation', () => {
    expect(classifyAge(policy.hardTtlMs, undefined, 0, policy)).toBe('expired')
    // A message that would also be escalation-due must still expire.
    expect(classifyAge(policy.hardTtlMs + HOUR, 0, policy.hardTtlMs + HOUR, policy)).toBe('expired')
  })

  it('throttles the re-alert: recently escalated -> wait, interval elapsed -> escalate', () => {
    const now = 10 * HOUR
    const age = 2 * HOUR // overdue, far from TTL
    const recentlyEscalated = now - policy.reAlertIntervalMs + 1
    const longAgo = now - policy.reAlertIntervalMs
    expect(classifyAge(age, recentlyEscalated, now, policy)).toBe('wait')
    expect(classifyAge(age, longAgo, now, policy)).toBe('escalate')
  })

  it('urgent messages first-cross at 15 min, not 60', () => {
    const urgent = retryPolicyFor('urgent')
    expect(classifyAge(15 * MIN, undefined, 0, urgent)).toBe('escalate')
    expect(classifyAge(14 * MIN, undefined, 0, urgent)).toBe('wait')
  })
})

// ---------------------------------------------------------------------------
// orderForDrain
// ---------------------------------------------------------------------------

describe('orderForDrain', () => {
  it('sorts by priority (highest first), then FIFO within a priority, then id', () => {
    const input = [
      msg({ id: 1, priority: 'low', createdAtMs: 100 }),
      msg({ id: 2, priority: 'urgent', createdAtMs: 500 }),
      msg({ id: 3, priority: 'normal', createdAtMs: 200 }),
      msg({ id: 4, priority: 'normal', createdAtMs: 100 }),
      msg({ id: 5, priority: 'normal', createdAtMs: 100 }),
    ]
    expect(orderForDrain(input).map((m) => m.id)).toEqual([2, 4, 5, 3, 1])
  })

  it('treats numeric and tier priorities on one scale', () => {
    const input = [
      msg({ id: 1, priority: 'high', createdAtMs: 0 }), // 75
      msg({ id: 2, priority: 80, createdAtMs: 0 }),
      msg({ id: 3, priority: 'urgent', createdAtMs: 0 }), // 100
    ]
    expect(orderForDrain(input).map((m) => m.id)).toEqual([3, 2, 1])
  })

  it('is pure: returns a new array and leaves the input untouched', () => {
    const input = [
      msg({ id: 1, priority: 'low', createdAtMs: 0 }),
      msg({ id: 2, priority: 'urgent', createdAtMs: 0 }),
    ]
    const snapshot = input.map((m) => m.id)
    const out = orderForDrain(input)
    expect(out).not.toBe(input)
    expect(input.map((m) => m.id)).toEqual(snapshot)
  })

  it('unknown priority drains as normal (between low and high)', () => {
    const input = [
      msg({ id: 1, priority: 'low', createdAtMs: 0 }),
      msg({ id: 2, priority: undefined, createdAtMs: 0 }),
      msg({ id: 3, priority: 'high', createdAtMs: 0 }),
    ]
    expect(orderForDrain(input).map((m) => m.id)).toEqual([3, 2, 1])
  })
})

// ---------------------------------------------------------------------------
// planDeliveryTick -- the tick planner
// ---------------------------------------------------------------------------

describe('planDeliveryTick', () => {
  it('emits exactly one step per pending message, in drain order', () => {
    const steps = planDeliveryTick({
      nowMs: 1000,
      pending: [
        msg({ id: 1, to: 'a', priority: 'low', createdAtMs: 0 }),
        msg({ id: 2, to: 'b', priority: 'urgent', createdAtMs: 0 }),
      ],
      recipients: new Map([
        ['a', ready()],
        ['b', ready()],
      ]),
    })
    expect(steps).toHaveLength(2)
    expect(steps.map((s) => s.id)).toEqual([2, 1])
  })

  it('delivers to a ready recipient', () => {
    const steps = planDeliveryTick({
      nowMs: 1000,
      pending: [msg({ id: 1, to: 'a', createdAtMs: 0 })],
      recipients: new Map([['a', ready()]]),
    })
    expect(stepFor(steps, 1)).toMatchObject({ kind: 'deliver', to: 'a', recordEscalation: false })
  })

  it('defers on a busy recipient (never drops)', () => {
    const steps = planDeliveryTick({
      nowMs: 1000,
      pending: [msg({ id: 1, to: 'a', createdAtMs: 0 })],
      recipients: new Map([['a', busy()]]),
    })
    expect(stepFor(steps, 1)).toMatchObject({ kind: 'defer', reason: 'recipient-busy' })
  })

  it('defers when the recipient session is missing or not running', () => {
    const steps = planDeliveryTick({
      nowMs: 1000,
      pending: [
        msg({ id: 1, to: 'gone', createdAtMs: 0 }),
        msg({ id: 2, to: 'down', createdAtMs: 0 }),
      ],
      recipients: new Map([['down', { sessionRunning: false, readyForPrompt: false }]]),
    })
    expect(stepFor(steps, 1)).toMatchObject({ kind: 'defer', reason: 'session-missing' })
    expect(stepFor(steps, 2)).toMatchObject({ kind: 'defer', reason: 'session-missing' })
  })

  it('expires a message past the hard-TTL even if the recipient is ready', () => {
    const now = 100 * HOUR
    const steps = planDeliveryTick({
      nowMs: now,
      pending: [msg({ id: 1, to: 'a', createdAtMs: now - HARD_TTL_MS })],
      recipients: new Map([['a', ready()]]),
    })
    expect(stepFor(steps, 1)).toMatchObject({ kind: 'expire', ageMs: HARD_TTL_MS })
  })

  it('INVARIANT: priority never expires a message earlier than any other priority', () => {
    const now = 100 * HOUR
    const age = HARD_TTL_MS - 1
    const steps = planDeliveryTick({
      nowMs: now,
      pending: [
        msg({ id: 1, to: 'a', priority: 'urgent', createdAtMs: now - age }),
        msg({ id: 2, to: 'a', priority: 'low', createdAtMs: now - age }),
      ],
      recipients: new Map([['a', busy()]]),
    })
    expect(stepFor(steps, 1).kind).not.toBe('expire')
    expect(stepFor(steps, 2).kind).not.toBe('expire')
  })

  it('consumes the idle window: one delivery per recipient per tick', () => {
    const steps = planDeliveryTick({
      nowMs: 1000,
      pending: [
        msg({ id: 1, to: 'a', priority: 'urgent', createdAtMs: 0 }),
        msg({ id: 2, to: 'a', priority: 'normal', createdAtMs: 0 }),
        msg({ id: 3, to: 'b', priority: 'normal', createdAtMs: 0 }),
      ],
      recipients: new Map([
        ['a', ready()],
        ['b', ready()],
      ]),
    })
    expect(stepFor(steps, 1).kind).toBe('deliver')
    expect(stepFor(steps, 2)).toMatchObject({ kind: 'defer', reason: 'idle-window-consumed' })
    // Independent recipients are unaffected by each other's window.
    expect(stepFor(steps, 3).kind).toBe('deliver')
  })

  it('an expired message does NOT consume the idle window', () => {
    const now = 100 * HOUR
    const steps = planDeliveryTick({
      nowMs: now,
      pending: [
        msg({ id: 1, to: 'a', priority: 'urgent', createdAtMs: now - HARD_TTL_MS }),
        msg({ id: 2, to: 'a', priority: 'low', createdAtMs: now - 1000 }),
      ],
      recipients: new Map([['a', ready()]]),
    })
    expect(stepFor(steps, 1).kind).toBe('expire')
    expect(stepFor(steps, 2).kind).toBe('deliver')
  })

  it('flags escalation bookkeeping on the first overdue crossing, even while deferred', () => {
    const now = 100 * HOUR
    const steps = planDeliveryTick({
      nowMs: now,
      pending: [msg({ id: 1, to: 'a', createdAtMs: now - ESCALATE_AFTER_DEFAULT_MS })],
      recipients: new Map([['a', busy()]]),
      // Probe recently attempted, so this tick can only defer -- the overdue
      // bookkeeping must still be requested on the defer step.
      lastBackstopProbeAtMs: new Map([[1, now - 1000]]),
    })
    expect(stepFor(steps, 1)).toMatchObject({
      kind: 'defer',
      reason: 'probe-throttled',
      recordEscalation: true,
    })
  })

  it('throttles the re-alert via lastEscalatedAtMs', () => {
    const now = 100 * HOUR
    const overdueBy2h = msg({ id: 1, to: 'a', createdAtMs: now - 2 * HOUR })
    const recentlyNagged = { ...overdueBy2h, lastEscalatedAtMs: now - 10 * MIN }
    const naggedLongAgo = { ...overdueBy2h, id: 2, lastEscalatedAtMs: now - ESCALATE_AFTER_DEFAULT_MS }
    const steps = planDeliveryTick({
      nowMs: now,
      pending: [recentlyNagged, naggedLongAgo],
      recipients: new Map([['a', busy()]]),
    })
    expect(stepFor(steps, 1)).toMatchObject({ recordEscalation: false })
    expect(stepFor(steps, 2)).toMatchObject({ recordEscalation: true })
  })

  it('an overdue message delivered to a now-ready recipient still records its escalation', () => {
    const now = 100 * HOUR
    const steps = planDeliveryTick({
      nowMs: now,
      pending: [msg({ id: 1, to: 'a', createdAtMs: now - 2 * HOUR })],
      recipients: new Map([['a', ready()]]),
    })
    expect(stepFor(steps, 1)).toMatchObject({ kind: 'deliver', recordEscalation: true })
  })

  describe('quiescence backstop', () => {
    it('requests a pane re-proof once a message is old enough and unthrottled', () => {
      const now = 100 * HOUR
      const steps = planDeliveryTick({
        nowMs: now,
        pending: [msg({ id: 1, to: 'a', createdAtMs: now - BACKSTOP_AFTER_MS })],
        recipients: new Map([['a', busy()]]),
      })
      expect(stepFor(steps, 1)).toMatchObject({ kind: 'backstop-probe', to: 'a' })
    })

    it('does not probe a message younger than the backstop age gate', () => {
      const now = 100 * HOUR
      const steps = planDeliveryTick({
        nowMs: now,
        pending: [msg({ id: 1, to: 'a', createdAtMs: now - BACKSTOP_AFTER_MS + 1 })],
        recipients: new Map([['a', busy()]]),
      })
      expect(stepFor(steps, 1)).toMatchObject({ kind: 'defer', reason: 'recipient-busy' })
    })

    it('throttles the probe per message via lastBackstopProbeAtMs', () => {
      const now = 100 * HOUR
      const base = {
        nowMs: now,
        pending: [msg({ id: 1, to: 'a', createdAtMs: now - HOUR })],
        recipients: new Map([['a', busy()]]),
      }
      const throttled = planDeliveryTick({
        ...base,
        lastBackstopProbeAtMs: new Map([[1, now - BACKSTOP_THROTTLE_MS + 1]]),
      })
      expect(stepFor(throttled, 1)).toMatchObject({ kind: 'defer', reason: 'probe-throttled' })
      const dueAgain = planDeliveryTick({
        ...base,
        lastBackstopProbeAtMs: new Map([[1, now - BACKSTOP_THROTTLE_MS]]),
      })
      expect(stepFor(dueAgain, 1)).toMatchObject({ kind: 'backstop-probe' })
    })

    it('emits at most one probe per recipient per tick (pane sampling is expensive)', () => {
      const now = 100 * HOUR
      const steps = planDeliveryTick({
        nowMs: now,
        pending: [
          msg({ id: 1, to: 'a', priority: 'urgent', createdAtMs: now - HOUR }),
          msg({ id: 2, to: 'a', priority: 'normal', createdAtMs: now - HOUR }),
          msg({ id: 3, to: 'b', priority: 'normal', createdAtMs: now - HOUR }),
        ],
        recipients: new Map([
          ['a', busy()],
          ['b', busy()],
        ]),
      })
      expect(stepFor(steps, 1).kind).toBe('backstop-probe')
      expect(stepFor(steps, 2)).toMatchObject({ kind: 'defer', reason: 'probe-throttled' })
      expect(stepFor(steps, 3).kind).toBe('backstop-probe')
    })

    it('backstop gate stays comfortably below the earliest escalation window', () => {
      expect(BACKSTOP_AFTER_MS).toBeLessThan(ESCALATE_AFTER_URGENT_MS)
    })
  })

  describe('delivery hold (fleet pause)', () => {
    it('holds an otherwise-deliverable message without touching the pending row', () => {
      const steps = planDeliveryTick({
        nowMs: 1000,
        pending: [msg({ id: 1, to: 'a', createdAtMs: 0 })],
        recipients: new Map([['a', ready()]]),
        holdDelivery: () => true,
      })
      expect(stepFor(steps, 1)).toMatchObject({ kind: 'defer', reason: 'delivery-held' })
    })

    it('a hold suppresses the backstop probe (no pane sampling while paused)', () => {
      const now = 100 * HOUR
      const steps = planDeliveryTick({
        nowMs: now,
        pending: [msg({ id: 1, to: 'a', createdAtMs: now - HOUR })],
        recipients: new Map([['a', busy()]]),
        holdDelivery: () => true,
      })
      expect(stepFor(steps, 1)).toMatchObject({ kind: 'defer', reason: 'delivery-held' })
    })

    it('a hold does NOT block the hard-TTL expiry (bookkeeping is not proactive work)', () => {
      const now = 100 * HOUR
      const steps = planDeliveryTick({
        nowMs: now,
        pending: [msg({ id: 1, to: 'a', createdAtMs: now - HARD_TTL_MS })],
        recipients: new Map([['a', ready()]]),
        holdDelivery: () => true,
      })
      expect(stepFor(steps, 1).kind).toBe('expire')
    })

    it('the hold predicate is consulted per message', () => {
      const steps = planDeliveryTick({
        nowMs: 1000,
        pending: [
          msg({ id: 1, to: 'a', createdAtMs: 0 }),
          msg({ id: 2, to: 'b', createdAtMs: 0 }),
        ],
        recipients: new Map([
          ['a', ready()],
          ['b', ready()],
        ]),
        holdDelivery: (m) => m.to === 'a',
      })
      expect(stepFor(steps, 1)).toMatchObject({ kind: 'defer', reason: 'delivery-held' })
      expect(stepFor(steps, 2).kind).toBe('deliver')
    })
  })

  it('scenario: mixed backlog drains correctly in one tick', () => {
    const now = 100 * HOUR
    const steps = planDeliveryTick({
      nowMs: now,
      pending: [
        // Stale low-priority backlog to the orchestrator, plus a fresh urgent:
        // the urgent must be offered first when the pane frees up.
        msg({ id: 1, to: 'orchestrator', priority: 'low', createdAtMs: now - 3 * HOUR }),
        msg({ id: 2, to: 'orchestrator', priority: 'urgent', createdAtMs: now - MIN }),
        // A message far past the TTL to a dead session.
        msg({ id: 3, to: 'ghost', priority: 'high', createdAtMs: now - 7 * HOUR }),
        // A normal message to an idle worker.
        msg({ id: 4, to: 'worker', priority: 'normal', createdAtMs: now - MIN }),
      ],
      recipients: new Map([
        ['orchestrator', ready()],
        ['worker', ready()],
      ]),
    })
    expect(steps.map((s) => s.id)).toEqual([2, 3, 4, 1])
    expect(stepFor(steps, 2).kind).toBe('deliver')
    expect(stepFor(steps, 3).kind).toBe('expire')
    expect(stepFor(steps, 4).kind).toBe('deliver')
    // The stale low-priority message waits for the next idle window; it is
    // deferred, never dropped (recordEscalation surfaces it out-of-band).
    expect(stepFor(steps, 1)).toMatchObject({
      kind: 'defer',
      reason: 'idle-window-consumed',
      recordEscalation: true,
    })
  })
})

// ---------------------------------------------------------------------------
// pruneStaleThrottleState
// ---------------------------------------------------------------------------

describe('pruneStaleThrottleState', () => {
  it('drops entries whose id is no longer pending, keeps live ones', () => {
    const state = new Map<number, number>([
      [1, 100],
      [2, 200],
      [3, 300],
    ])
    pruneStaleThrottleState(state, new Set([2]))
    expect([...state.keys()]).toEqual([2])
  })

  it('leaves an empty map empty without error', () => {
    const state = new Map<number, number>()
    pruneStaleThrottleState(state, new Set([1]))
    expect(state.size).toBe(0)
  })
})
