import { describe, it, expect } from 'vitest'
import {
  decideWedgeRecovery,
  DEFAULT_WEDGE_THRESHOLDS,
  type WedgeSignal,
  type WedgeRecoveryState,
  type WedgeThresholds,
} from '../web/wedge-detector.js'

// Card c88bc682 / OPS-007: pure decision core for staged-input-wedge auto-recovery.
// The wedge = alive agent (recent outbound) whose inbox stalls (delivered_at NULL
// for 40min+). Recovery = context-preserving restart. These tests pin the
// behaviour AND the adversarial false-positive / false-negative cases the gate
// requires -- an over-eager detector would restart healthy agents mid-turn.

const T: WedgeThresholds = DEFAULT_WEDGE_THRESHOLDS
const FRESH: WedgeRecoveryState = { lastActionAtMs: null, recoveryCount: 0, escalationCount: 0 }
const NOW = 1_000_000_000_000

// A canonical wedged agent: 45-min-old pending inbox, outbound 10 min ago.
function wedged(over: Partial<WedgeSignal> = {}): WedgeSignal {
  return {
    hasPendingInbound: true,
    oldestPendingAgeMin: 45,
    lastOutboundAgeMin: 10,
    sawAbandonEvent: false,
    ...over,
  }
}

describe('decideWedgeRecovery -- fires on a true wedge (false-negative guard)', () => {
  it('recovers when the inbox is overdue and the agent is still emitting outbound', () => {
    const d = decideWedgeRecovery(wedged(), FRESH, NOW, T)
    expect(d.action).toBe('recover')
    expect(d.next.recoveryCount).toBe(1)
    expect(d.next.lastActionAtMs).toBe(NOW)
  })

  it('recovers on a delivery-monitor abandon event when outbound is recent', () => {
    // No overdue-pending computed, but a hard-TTL abandon fired this cycle.
    const sig = wedged({ hasPendingInbound: false, oldestPendingAgeMin: 0, sawAbandonEvent: true })
    const d = decideWedgeRecovery(sig, FRESH, NOW, T)
    expect(d.action).toBe('recover')
  })

  it('recovers exactly at the overdue boundary (>= overdueMins)', () => {
    const d = decideWedgeRecovery(wedged({ oldestPendingAgeMin: T.overdueMins }), FRESH, NOW, T)
    expect(d.action).toBe('recover')
  })

  it('recovers when outbound is exactly at the recent boundary (<= outboundRecentMins)', () => {
    const d = decideWedgeRecovery(wedged({ lastOutboundAgeMin: T.outboundRecentMins }), FRESH, NOW, T)
    expect(d.action).toBe('recover')
  })
})

describe('decideWedgeRecovery -- false-positive guards (must NOT restart a healthy agent)', () => {
  it('does NOT recover a dead/idle agent: overdue inbox but NO recent outbound', () => {
    // The single most important guard: a stuck inbox with no outbound is a
    // crashed/idle agent (watchdog territory), NOT a staged-input wedge.
    const d = decideWedgeRecovery(wedged({ lastOutboundAgeMin: null }), FRESH, NOW, T)
    expect(d.action).toBe('none')
    expect(d.reason).toMatch(/no recent outbound/i)
  })

  it('does NOT recover when outbound is stale (older than the recent window)', () => {
    const d = decideWedgeRecovery(wedged({ lastOutboundAgeMin: T.outboundRecentMins + 1 }), FRESH, NOW, T)
    expect(d.action).toBe('none')
  })

  it('does NOT recover a merely-busy agent: pending but below the overdue threshold', () => {
    const d = decideWedgeRecovery(wedged({ oldestPendingAgeMin: T.overdueMins - 1 }), FRESH, NOW, T)
    expect(d.action).toBe('none')
    expect(d.reason).toMatch(/below overdue/i)
  })

  it('does NOT recover a healthy agent with a draining/empty inbox, and resets state', () => {
    const prev: WedgeRecoveryState = { lastActionAtMs: NOW - 10, recoveryCount: 2 }
    const d = decideWedgeRecovery(
      { hasPendingInbound: false, oldestPendingAgeMin: 0, lastOutboundAgeMin: 5, sawAbandonEvent: false },
      prev, NOW, T,
    )
    expect(d.action).toBe('none')
    expect(d.next).toEqual({ lastActionAtMs: null, recoveryCount: 0, escalationCount: 0 })
  })

  it('does NOT restart-thrash: waits while inside the cooldown after a recovery', () => {
    const prev: WedgeRecoveryState = { lastActionAtMs: NOW - (T.cooldownMs - 1), recoveryCount: 1 }
    const d = decideWedgeRecovery(wedged(), prev, NOW, T)
    expect(d.action).toBe('wait')
    expect(d.next).toEqual(prev) // unchanged during cooldown
  })

  it('recovers again once the cooldown has fully elapsed and it is still wedged', () => {
    const prev: WedgeRecoveryState = { lastActionAtMs: NOW - T.cooldownMs, recoveryCount: 1 }
    const d = decideWedgeRecovery(wedged(), prev, NOW, T)
    expect(d.action).toBe('recover')
    expect(d.next.recoveryCount).toBe(2)
  })
})

describe('decideWedgeRecovery -- escalation when restart is not fixing it', () => {
  it('escalates instead of recovering once the recovery cap is reached', () => {
    const prev: WedgeRecoveryState = { lastActionAtMs: NOW - T.cooldownMs, recoveryCount: T.maxRecoveries }
    const d = decideWedgeRecovery(wedged(), prev, NOW, T)
    expect(d.action).toBe('escalate')
    expect(d.next.recoveryCount).toBe(T.maxRecoveries) // count held, not bumped
    expect(d.next.lastActionAtMs).toBe(NOW) // timestamp bumped so escalation is throttled too
    expect(d.next.escalationCount).toBe(1) // first escalation for this incident
  })

  it('throttles escalation by the same cooldown (no operator spam)', () => {
    const prev: WedgeRecoveryState = { lastActionAtMs: NOW - 1, recoveryCount: T.maxRecoveries }
    const d = decideWedgeRecovery(wedged(), prev, NOW, T)
    expect(d.action).toBe('wait')
  })

  // DA flag (card c88bc682): without a cap the state machine re-escalated every
  // cooldown forever. Escalation must be BOUNDED per incident, then fall silent.
  it('falls silent once the escalation cap is reached (no infinite alert loop)', () => {
    const prev: WedgeRecoveryState = {
      lastActionAtMs: NOW - T.cooldownMs, recoveryCount: T.maxRecoveries, escalationCount: T.maxEscalations,
    }
    const d = decideWedgeRecovery(wedged(), prev, NOW, T)
    expect(d.action).toBe('none')
    expect(d.reason).toMatch(/escalation cap/i)
    expect(d.next).toEqual(prev) // no further side effects while silent
  })

  it('bounds escalations across a long stuck incident: recover*max -> escalate*maxEsc -> silent', () => {
    // Simulate an agent that stays wedged forever, each cycle a full cooldown apart.
    // Alerts (recover + escalate) must be finite; after that the machine is silent.
    let state: WedgeRecoveryState = { ...FRESH }
    let t = NOW
    const actions: string[] = []
    for (let i = 0; i < 12; i++) {
      const d = decideWedgeRecovery(wedged(), state, t, T)
      actions.push(d.action)
      state = d.next
      t += T.cooldownMs // advance past cooldown each cycle
    }
    const recovers = actions.filter(a => a === 'recover').length
    const escalates = actions.filter(a => a === 'escalate').length
    expect(recovers).toBe(T.maxRecoveries)
    expect(escalates).toBe(T.maxEscalations)
    // every remaining cycle is silent -- the alert stream is bounded, not infinite
    expect(actions.slice(T.maxRecoveries + T.maxEscalations).every(a => a === 'none')).toBe(true)
  })
})

describe('decideWedgeRecovery -- adversarial / spoof-resistance sanity', () => {
  it('an abandon event alone (no outbound) does NOT trigger a restart', () => {
    // A genuinely dead recipient hits the 360-min abandon, but must not be
    // auto-restarted here -- the recent-outbound guard blocks it.
    const sig: WedgeSignal = {
      hasPendingInbound: true, oldestPendingAgeMin: 361, lastOutboundAgeMin: null, sawAbandonEvent: true,
    }
    const d = decideWedgeRecovery(sig, FRESH, NOW, T)
    expect(d.action).toBe('none')
  })

  it('is deterministic: same inputs yield the same decision', () => {
    const a = decideWedgeRecovery(wedged(), FRESH, NOW, T)
    const b = decideWedgeRecovery(wedged(), FRESH, NOW, T)
    expect(a).toEqual(b)
  })
})
