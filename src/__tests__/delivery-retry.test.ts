import { describe, it, expect } from 'vitest'
import {
  classifyPendingMessage,
  pruneEscalationState,
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
