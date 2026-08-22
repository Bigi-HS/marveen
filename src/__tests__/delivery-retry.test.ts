import { describe, it, expect } from 'vitest'
import {
  classifyPendingMessage,
  pruneEscalationState,
  thresholdsForPriority,
  priorityRank,
  orderPendingByPriority,
  shouldQuiescentRedeliver,
  QUIESCENT_REDELIVER_AFTER_MS,
  DEFAULT_RETRY_THRESHOLDS,
  MESSAGE_ESCALATE_AFTER_MS,
  MESSAGE_HARD_TTL_MS,
} from '../web/delivery-retry.js'

// Card 7557a98d: a legitimately-busy recipient must NOT lose a still-valid
// message. The old behaviour dropped (markMessageFailed) at 60 min; the fix
// keeps RETRYING until a 6 h hard-TTL, and meanwhile ESCALATES on a throttled
// cadence (first at 60 min, then ~hourly) instead of a single easily-missed
// ping. classifyPendingMessage is the pure decision behind that.

const T = DEFAULT_RETRY_THRESHOLDS
const NOW = 1_000_000_000_000

describe('classifyPendingMessage', () => {
  it('waits while younger than the escalate-after window (keeps delivering)', () => {
    expect(classifyPendingMessage(MESSAGE_ESCALATE_AFTER_MS - 1, undefined, NOW, T)).toBe('wait')
    expect(classifyPendingMessage(0, undefined, NOW, T)).toBe('wait')
  })

  it('escalates the first time it crosses the escalate-after window', () => {
    expect(classifyPendingMessage(MESSAGE_ESCALATE_AFTER_MS, undefined, NOW, T)).toBe('escalate')
    expect(classifyPendingMessage(MESSAGE_ESCALATE_AFTER_MS + 5000, undefined, NOW, T)).toBe('escalate')
  })

  it('does NOT hard-fail when overdue but under the hard-TTL (still retrying)', () => {
    // The whole point: between 60 min and 6 h the message stays pending.
    const overdue = classifyPendingMessage(MESSAGE_HARD_TTL_MS - 1, NOW - 1000, NOW, T)
    expect(overdue).not.toBe('hard-fail')
  })

  it('re-escalates only after the re-alert interval has elapsed since the last escalation', () => {
    const age = MESSAGE_ESCALATE_AFTER_MS + T.reAlertIntervalMs + 1000
    // just escalated 1 min ago -> throttled, wait
    expect(classifyPendingMessage(age, NOW - 60_000, NOW, T)).toBe('wait')
    // last escalated a full interval ago -> escalate again
    expect(classifyPendingMessage(age, NOW - T.reAlertIntervalMs, NOW, T)).toBe('escalate')
    expect(classifyPendingMessage(age, NOW - T.reAlertIntervalMs - 1, NOW, T)).toBe('escalate')
  })

  it('hard-fails at or beyond the hard-TTL regardless of escalation state', () => {
    expect(classifyPendingMessage(MESSAGE_HARD_TTL_MS, undefined, NOW, T)).toBe('hard-fail')
    expect(classifyPendingMessage(MESSAGE_HARD_TTL_MS + 1, NOW - 1000, NOW, T)).toBe('hard-fail')
  })

  it('honours custom thresholds', () => {
    const t = { escalateAfterMs: 10, reAlertIntervalMs: 10, hardTtlMs: 100 }
    expect(classifyPendingMessage(5, undefined, NOW, t)).toBe('wait')
    expect(classifyPendingMessage(10, undefined, NOW, t)).toBe('escalate')
    expect(classifyPendingMessage(100, undefined, NOW, t)).toBe('hard-fail')
  })
})

describe('default thresholds', () => {
  it('escalate-after is 60 min, hard-TTL is 6 h, re-alert is hourly', () => {
    expect(DEFAULT_RETRY_THRESHOLDS.escalateAfterMs).toBe(60 * 60 * 1000)
    expect(DEFAULT_RETRY_THRESHOLDS.hardTtlMs).toBe(6 * 60 * 60 * 1000)
    expect(DEFAULT_RETRY_THRESHOLDS.reAlertIntervalMs).toBe(60 * 60 * 1000)
  })

  it('escalate-after is strictly less than hard-TTL (retry window is non-empty)', () => {
    expect(DEFAULT_RETRY_THRESHOLDS.escalateAfterMs).toBeLessThan(DEFAULT_RETRY_THRESHOLDS.hardTtlMs)
  })
})

// Note: the in-band overdue alert + its restart-amplification guard
// (shouldAlertInBand / FIRST_CROSSING_GRACE_MS, card 7557a98d) were removed in
// card f1ea52c0 -- 'overdue' is now sentinel-only, so the in-band gate no longer
// exists. Only a permanent 'dropped' give-up alerts in-band; see
// delivery-alert.test.ts > alertInBand.

// Card 28d2179f (DA verdict on PR #130): a flat 60-min escalate-after means
// time-sensitive inter-agent messages (T3 triggers, deploy-GO, gate requests)
// sit silently for an hour before anyone is alerted. Fix: derive the escalation
// timing from the message's priority. CRUCIAL INVARIANT -- only the ESCALATION
// (alert) timing accelerates; the 6 h hard-TTL stays constant for EVERY priority
// so we never DROP a still-valid message earlier than before. Priority only ever
// makes us shout sooner, never give up sooner.
describe('thresholdsForPriority (card 28d2179f)', () => {
  const FIFTEEN_MIN = 15 * 60 * 1000
  const THIRTY_MIN = 30 * 60 * 1000
  const SIXTY_MIN = 60 * 60 * 1000

  it('urgent escalates at 15 min (and re-nags at 15 min)', () => {
    const t = thresholdsForPriority('urgent')
    expect(t.escalateAfterMs).toBe(FIFTEEN_MIN)
    expect(t.reAlertIntervalMs).toBe(FIFTEEN_MIN)
  })

  it('high escalates at 30 min (monotone middle between urgent and normal)', () => {
    const t = thresholdsForPriority('high')
    expect(t.escalateAfterMs).toBe(THIRTY_MIN)
    expect(t.reAlertIntervalMs).toBe(THIRTY_MIN)
  })

  it('normal keeps the legacy 60-min behaviour (== DEFAULT_RETRY_THRESHOLDS)', () => {
    expect(thresholdsForPriority('normal')).toEqual(DEFAULT_RETRY_THRESHOLDS)
    expect(thresholdsForPriority('normal').escalateAfterMs).toBe(SIXTY_MIN)
  })

  it('low is no more urgent than normal (low != "low latency")', () => {
    expect(thresholdsForPriority('low')).toEqual(DEFAULT_RETRY_THRESHOLDS)
  })

  it('hard-TTL is a constant 6 h for EVERY priority (never drop a valid msg earlier)', () => {
    for (const p of ['low', 'normal', 'high', 'urgent'] as const) {
      expect(thresholdsForPriority(p).hardTtlMs).toBe(MESSAGE_HARD_TTL_MS)
    }
  })

  it('escalate-after is monotone non-increasing with urgency (urgent <= high <= normal)', () => {
    expect(thresholdsForPriority('urgent').escalateAfterMs)
      .toBeLessThanOrEqual(thresholdsForPriority('high').escalateAfterMs)
    expect(thresholdsForPriority('high').escalateAfterMs)
      .toBeLessThanOrEqual(thresholdsForPriority('normal').escalateAfterMs)
  })

  it('every priority keeps a non-empty retry window (escalateAfter < hardTTL)', () => {
    for (const p of ['low', 'normal', 'high', 'urgent'] as const) {
      const t = thresholdsForPriority(p)
      expect(t.escalateAfterMs).toBeLessThan(t.hardTtlMs)
    }
  })

  it('falls back to DEFAULT for an unknown / undefined priority (defensive)', () => {
    expect(thresholdsForPriority(undefined)).toEqual(DEFAULT_RETRY_THRESHOLDS)
    // @ts-expect-error -- exercise the runtime guard against a bad DB value
    expect(thresholdsForPriority('bogus')).toEqual(DEFAULT_RETRY_THRESHOLDS)
  })

  it('composes with classifyPendingMessage: an urgent msg escalates at 15 min, a normal one still waits', () => {
    const urgentT = thresholdsForPriority('urgent')
    const normalT = thresholdsForPriority('normal')
    const age = 16 * 60 * 1000 // 16 min old
    expect(classifyPendingMessage(age, undefined, NOW, urgentT)).toBe('escalate')
    expect(classifyPendingMessage(age, undefined, NOW, normalT)).toBe('wait')
  })
})

describe('pruneEscalationState', () => {
  it('drops escalation entries for ids no longer pending (delivered or failed)', () => {
    const state = new Map<number, number>([[1, NOW], [2, NOW], [3, NOW]])
    pruneEscalationState(state, new Set([2, 3]))
    expect([...state.keys()].sort((a, b) => a - b)).toEqual([2, 3])
  })

  it('is a no-op when every tracked id is still pending', () => {
    const state = new Map<number, number>([[5, NOW]])
    pruneEscalationState(state, new Set([5]))
    expect([...state.keys()]).toEqual([5])
  })

  it('clears everything when nothing is pending', () => {
    const state = new Map<number, number>([[1, NOW], [2, NOW]])
    pruneEscalationState(state, new Set<number>())
    expect(state.size).toBe(0)
  })
})

// Card 83d9dde6 (Thread B, F1): when a busy recipient (typically the
// orchestrator) frees up after a long stretch, its backlog drains one effective
// delivery per idle window (an inject makes the pane busy for the turn). The
// router previously drained that backlog strictly FIFO (created_at ASC), so a
// fresh urgent update arrived behind stale low-priority ones. orderPendingByPriority
// reorders the drain by priority (highest first) while keeping FIFO WITHIN a
// priority. It is a pure reordering: it never drops, never changes per-message
// escalation/hard-fail (those are decided independently in the loop), and the
// hard-TTL is untouched.
describe('priorityRank (card 83d9dde6)', () => {
  it('ranks urgent > high > normal > low', () => {
    expect(priorityRank('urgent')).toBeGreaterThan(priorityRank('high'))
    expect(priorityRank('high')).toBeGreaterThan(priorityRank('normal'))
    expect(priorityRank('normal')).toBeGreaterThan(priorityRank('low'))
  })

  it('treats unknown/undefined/null priority as normal (matches thresholdsForPriority fallback)', () => {
    expect(priorityRank(undefined)).toBe(priorityRank('normal'))
    expect(priorityRank(null)).toBe(priorityRank('normal'))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(priorityRank('garbage' as any)).toBe(priorityRank('normal'))
  })
})

describe('orderPendingByPriority (card 83d9dde6)', () => {
  it('orders by priority (highest first), FIFO within a priority', () => {
    const msgs = [
      { id: 1, priority: 'low' as const, created_at: 100 },
      { id: 2, priority: 'urgent' as const, created_at: 200 },
      { id: 3, priority: 'normal' as const, created_at: 150 },
      { id: 4, priority: 'urgent' as const, created_at: 120 },
      { id: 5, priority: 'high' as const, created_at: 110 },
    ]
    expect(orderPendingByPriority(msgs).map((m) => m.id)).toEqual([4, 2, 5, 3, 1])
  })

  it('keeps strict FIFO (created_at ASC) when all priorities are equal', () => {
    const msgs = [
      { id: 1, priority: 'normal' as const, created_at: 300 },
      { id: 2, priority: 'normal' as const, created_at: 100 },
      { id: 3, priority: 'normal' as const, created_at: 200 },
    ]
    expect(orderPendingByPriority(msgs).map((m) => m.id)).toEqual([2, 3, 1])
  })

  it('breaks a created_at tie deterministically by id ASC (older id first)', () => {
    const msgs = [
      { id: 9, priority: 'high' as const, created_at: 100 },
      { id: 4, priority: 'high' as const, created_at: 100 },
    ]
    expect(orderPendingByPriority(msgs).map((m) => m.id)).toEqual([4, 9])
  })

  it('treats a missing priority as normal in the ordering', () => {
    const msgs = [
      { id: 1, created_at: 100 },
      { id: 2, priority: 'high' as const, created_at: 200 },
      { id: 3, priority: 'low' as const, created_at: 50 },
    ]
    expect(orderPendingByPriority(msgs).map((m) => m.id)).toEqual([2, 1, 3])
  })

  it('the core complaint: a fresh urgent jumps ahead of a stale low', () => {
    const staleLow = { id: 1, priority: 'low' as const, created_at: 1000 }
    const freshUrgent = { id: 2, priority: 'urgent' as const, created_at: 5000 }
    expect(orderPendingByPriority([staleLow, freshUrgent]).map((m) => m.id)).toEqual([2, 1])
  })

  it('does NOT mutate the input array (pure)', () => {
    const msgs = [
      { id: 1, priority: 'low' as const, created_at: 100 },
      { id: 2, priority: 'urgent' as const, created_at: 200 },
    ]
    const snapshot = msgs.map((m) => m.id)
    orderPendingByPriority(msgs)
    expect(msgs.map((m) => m.id)).toEqual(snapshot)
  })

  it('returns an empty array unchanged', () => {
    expect(orderPendingByPriority([])).toEqual([])
  })
})

describe('shouldQuiescentRedeliver (L2 backstop age gate, card d4aa1d14)', () => {
  it('does not engage before the redeliver-after window', () => {
    expect(shouldQuiescentRedeliver(0)).toBe(false)
    expect(shouldQuiescentRedeliver(QUIESCENT_REDELIVER_AFTER_MS - 1)).toBe(false)
  })

  it('engages once the message has been undeliverable past the window', () => {
    expect(shouldQuiescentRedeliver(QUIESCENT_REDELIVER_AFTER_MS)).toBe(true)
    expect(shouldQuiescentRedeliver(QUIESCENT_REDELIVER_AFTER_MS + 1)).toBe(true)
  })

  it('honours a custom after-window', () => {
    expect(shouldQuiescentRedeliver(5000, 10_000)).toBe(false)
    expect(shouldQuiescentRedeliver(10_000, 10_000)).toBe(true)
  })

  it('fires well BELOW the earliest (urgent) escalate window, so it acts before escalation noise', () => {
    expect(QUIESCENT_REDELIVER_AFTER_MS).toBeLessThan(15 * 60 * 1000)
    expect(QUIESCENT_REDELIVER_AFTER_MS).toBeLessThan(MESSAGE_ESCALATE_AFTER_MS)
  })
})

// Card 88849f24 (A1->B1 cutover gate): once agent_messages.priority is the
// INTEGER column (25/50/75/100), the delivery logic reads integers instead of
// the TEXT enum. The pure functions must produce IDENTICAL behaviour for an
// integer as for its TEXT tier, and must keep working when a tick mixes both
// representations (the migrated rows are integers, a freshly-POSTed row may
// still be a string until the write side is cut over too).
describe('integer priority inputs (card 88849f24)', () => {
  it('thresholdsForPriority: each canonical integer matches its TEXT tier', () => {
    expect(thresholdsForPriority(100)).toEqual(thresholdsForPriority('urgent'))
    expect(thresholdsForPriority(75)).toEqual(thresholdsForPriority('high'))
    expect(thresholdsForPriority(50)).toEqual(thresholdsForPriority('normal'))
    expect(thresholdsForPriority(25)).toEqual(thresholdsForPriority('low'))
  })

  it('thresholdsForPriority: integer urgent escalates at 15 min, high at 30 min', () => {
    expect(thresholdsForPriority(100).escalateAfterMs).toBe(15 * 60 * 1000)
    expect(thresholdsForPriority(75).escalateAfterMs).toBe(30 * 60 * 1000)
    expect(thresholdsForPriority(50).escalateAfterMs).toBe(MESSAGE_ESCALATE_AFTER_MS)
  })

  it('thresholdsForPriority: an off-tier integer uses the highest threshold it reaches', () => {
    // 80 is >= high (75) but < urgent (100): high timing.
    expect(thresholdsForPriority(80)).toEqual(thresholdsForPriority('high'))
    // 110 is >= urgent: urgent timing.
    expect(thresholdsForPriority(110)).toEqual(thresholdsForPriority('urgent'))
  })

  it('thresholdsForPriority: hard-TTL stays invariant for integers too', () => {
    for (const p of [25, 50, 75, 100, 0, 999]) {
      expect(thresholdsForPriority(p).hardTtlMs).toBe(MESSAGE_HARD_TTL_MS)
    }
  })

  it('priorityRank: integers rank in the same order as their TEXT tiers', () => {
    expect(priorityRank(100)).toBeGreaterThan(priorityRank(75))
    expect(priorityRank(75)).toBeGreaterThan(priorityRank(50))
    expect(priorityRank(50)).toBeGreaterThan(priorityRank(25))
    expect(priorityRank(100)).toBeGreaterThan(priorityRank('high'))
    expect(priorityRank('urgent')).toBeGreaterThan(priorityRank(50))
  })

  it('orderPendingByPriority: a fresh urgent INTEGER jumps ahead of a stale low INTEGER', () => {
    const staleLow = { id: 1, priority: 25, created_at: 1000 }
    const freshUrgent = { id: 2, priority: 100, created_at: 5000 }
    expect(orderPendingByPriority([staleLow, freshUrgent]).map((m) => m.id)).toEqual([2, 1])
  })

  it('orderPendingByPriority: a tick mixing TEXT and INTEGER priorities orders correctly', () => {
    const msgs = [
      { id: 1, priority: 25, created_at: 100 }, // low (int)
      { id: 2, priority: 'urgent' as const, created_at: 200 }, // urgent (text)
      { id: 3, priority: 'normal' as const, created_at: 150 }, // normal (text)
      { id: 4, priority: 100, created_at: 120 }, // urgent (int)
      { id: 5, priority: 75, created_at: 110 }, // high (int)
    ]
    // urgent(120) < urgent(200) by FIFO, then high, normal, low.
    expect(orderPendingByPriority(msgs).map((m) => m.id)).toEqual([4, 2, 5, 3, 1])
  })
})
