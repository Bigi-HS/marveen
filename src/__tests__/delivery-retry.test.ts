import { describe, it, expect } from 'vitest'
import {
  classifyPendingMessage,
  pruneEscalationState,
  shouldAlertInBand,
  thresholdsForPriority,
  DEFAULT_RETRY_THRESHOLDS,
  MESSAGE_ESCALATE_AFTER_MS,
  MESSAGE_HARD_TTL_MS,
  FIRST_CROSSING_GRACE_MS,
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

// Card 7557a98d restart-amplification fix (12-agent adversarial review finding):
// escalationState is an in-process Map with no persistence, but pending messages
// survive a server restart in SQLite. After a restart, an already-overdue message
// has no in-process record, so the naive `firstEscalation = !state.has(id)` fires
// a FRESH in-band ping to the (often deaf) main agent on EVERY restart -- exactly
// the backlog amplification the "in-band ONCE" invariant exists to prevent, and
// the fleet has a daily restart storm. shouldAlertInBand distinguishes a genuine
// first crossing (age just over the threshold) from a restart rediscovery (age
// well past it): the latter is treated as already-escalated -> sentinel-only,
// out-of-band. No data loss either way (the 6 h give-up is age-based).
describe('shouldAlertInBand (restart-amplification guard)', () => {
  const T = DEFAULT_RETRY_THRESHOLDS

  it('alerts in-band on a genuine first crossing (no prior state, age just over threshold)', () => {
    expect(shouldAlertInBand(MESSAGE_ESCALATE_AFTER_MS, false)).toBe(true)
    expect(shouldAlertInBand(MESSAGE_ESCALATE_AFTER_MS + 5000, false)).toBe(true)
  })

  it('does NOT alert in-band when this process already escalated the id (re-alert is out-of-band)', () => {
    // hasPriorEscalation true -> the periodic re-nag rides purely on the sentinel.
    expect(shouldAlertInBand(MESSAGE_ESCALATE_AFTER_MS, true)).toBe(false)
    expect(shouldAlertInBand(MESSAGE_HARD_TTL_MS - 1, true)).toBe(false)
  })

  it('does NOT alert in-band on a restart rediscovery (no prior state, age well past threshold)', () => {
    // A 3 h-overdue message with no in-process record == throttle state lost to a
    // restart; it was almost certainly in-band-alerted before. Suppress, sentinel-only.
    expect(shouldAlertInBand(3 * 60 * 60 * 1000, false)).toBe(false)
    expect(shouldAlertInBand(MESSAGE_ESCALATE_AFTER_MS + FIRST_CROSSING_GRACE_MS, false)).toBe(false)
  })

  it('uses the grace window as the first-crossing/restart boundary (exclusive upper)', () => {
    expect(shouldAlertInBand(MESSAGE_ESCALATE_AFTER_MS + FIRST_CROSSING_GRACE_MS - 1, false)).toBe(true)
    expect(shouldAlertInBand(MESSAGE_ESCALATE_AFTER_MS + FIRST_CROSSING_GRACE_MS, false)).toBe(false)
  })

  it('honours custom thresholds and grace', () => {
    const t = { escalateAfterMs: 100, reAlertIntervalMs: 100, hardTtlMs: 1000 }
    expect(shouldAlertInBand(100, false, t, 10)).toBe(true)
    expect(shouldAlertInBand(109, false, t, 10)).toBe(true)
    expect(shouldAlertInBand(110, false, t, 10)).toBe(false)
  })

  it('grace is small relative to the re-alert interval (a restart cannot masquerade as a first crossing for long)', () => {
    expect(FIRST_CROSSING_GRACE_MS).toBeLessThan(T.reAlertIntervalMs)
  })
})

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

  it('the first-crossing grace stays well under even the urgent re-alert interval', () => {
    // shouldAlertInBand uses escalateAfter + grace as the first-crossing boundary;
    // for the restart-rediscovery guard to hold for urgent too, grace must be
    // smaller than the tightest re-alert interval.
    expect(FIRST_CROSSING_GRACE_MS).toBeLessThan(thresholdsForPriority('urgent').reAlertIntervalMs)
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
