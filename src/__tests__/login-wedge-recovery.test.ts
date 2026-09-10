import { describe, it, expect } from 'vitest'
import {
  decideLoginWedgeRecovery,
  DEFAULT_LOGIN_WEDGE_RECOVERY_THRESHOLDS,
  type LoginWedgeRecoveryState,
  type LoginWedgeSignal,
} from '../web/login-wedge-recovery.js'

// SLICE 2 (ba53fdee): the PURE decision core for OAuth login-wedge auto-recovery.
// The host loop (channel-monitor) captures the pane (detectsActiveLoginBox -> the
// STAGE-1 marker) and probes the inbox (overdue pending inbound not draining ->
// the STAGE-2 effect-probe), then feeds both here; this returns whether to fire a
// FRESH relaunch (drop --continue, which otherwise replays the stuck login UI).
//
// The two-stage gate is the whole safety story: unlike the usage-limit modal
// recovery (which fires on the pane marker alone and keeps --continue), a login
// recovery DROPS --continue and so destroys accumulated context. That higher
// stake demands a second, independent proof that the brain is genuinely frozen
// (inbox not draining) before the destructive action -- killing the scrollback /
// --continue-replay false-positive class the design doc calls out.

const T = DEFAULT_LOGIN_WEDGE_RECOVERY_THRESHOLDS
const CLEAN: LoginWedgeRecoveryState = {
  consecutiveWedgeTicks: 0,
  lastActionAtMs: null,
  relaunchCount: 0,
  escalationCount: 0,
}
const WEDGED: LoginWedgeSignal = { onLoginBox: true, inboxStuck: true }
const t0 = 1_000_000_000_000

// Drive the machine through N consecutive observations of the same signal,
// threading state, starting at t0 and advancing `stepMs` between ticks.
function run(signal: LoginWedgeSignal, ticks: number, stepMs = 60_000, start = CLEAN) {
  let state = start
  const decisions = []
  for (let i = 0; i < ticks; i++) {
    const d = decideLoginWedgeRecovery(signal, state, t0 + i * stepMs, T)
    decisions.push(d)
    state = d.next
  }
  return decisions
}

describe('decideLoginWedgeRecovery -- two-stage gate', () => {
  it('FN: a real sustained wedge (login box + stuck inbox) recovers after confirmTicks', () => {
    const [first, second] = run(WEDGED, 2)
    // First sighting only confirms -- no destructive action on a single frame.
    expect(first.action).toBe('none')
    expect(first.next.consecutiveWedgeTicks).toBe(1)
    // Second consecutive sighting reaches confirmTicks (2) -> fresh relaunch.
    expect(second.action).toBe('recover')
    expect(second.next.relaunchCount).toBe(1)
    expect(second.next.lastActionAtMs).toBe(t0 + 60_000)
  })

  it('FP kill: login box present but inbox DRAINING never recovers (scrollback / --continue replay)', () => {
    const decisions = run({ onLoginBox: true, inboxStuck: false }, 5)
    expect(decisions.every((d) => d.action === 'none')).toBe(true)
    // The spell is reset every tick: the draining inbox proves the brain is live.
    expect(decisions.every((d) => d.next.consecutiveWedgeTicks === 0)).toBe(true)
    expect(decisions.at(-1)!.reason).toMatch(/draining|not wedged/i)
  })

  it('FP kill: no login box -> reset, no action', () => {
    const d = decideLoginWedgeRecovery({ onLoginBox: false, inboxStuck: true }, { ...CLEAN, consecutiveWedgeTicks: 1 }, t0, T)
    expect(d.action).toBe('none')
    expect(d.next.consecutiveWedgeTicks).toBe(0)
  })

  it('opposing-combination: inbox drains mid-confirm -> streak resets, must NOT fire', () => {
    // Tick 1: fully wedged (streak -> 1). Tick 2: inbox drained (login string
    // lingers in scrollback but the agent is processing) -> reset, no relaunch.
    let s = decideLoginWedgeRecovery(WEDGED, CLEAN, t0, T).next
    expect(s.consecutiveWedgeTicks).toBe(1)
    const d2 = decideLoginWedgeRecovery({ onLoginBox: true, inboxStuck: false }, s, t0 + 60_000, T)
    expect(d2.action).toBe('none')
    expect(d2.next.consecutiveWedgeTicks).toBe(0)
  })
})

describe('decideLoginWedgeRecovery -- cooldown / cap / escalate', () => {
  it('within cooldown after a relaunch -> wait (streak keeps advancing)', () => {
    const afterRecover = { consecutiveWedgeTicks: 2, lastActionAtMs: t0, relaunchCount: 1, escalationCount: 0 }
    const d = decideLoginWedgeRecovery(WEDGED, afterRecover, t0 + 60_000, T) // 1 min < 5 min cooldown
    expect(d.action).toBe('wait')
    expect(d.next.consecutiveWedgeTicks).toBe(3)
  })

  it('relaunch cap reached -> escalate up to maxEscalations, then silent', () => {
    const capped = { consecutiveWedgeTicks: 5, lastActionAtMs: t0, relaunchCount: T.maxRelaunches, escalationCount: 0 }
    // Cooled down + cap hit -> escalate #1.
    const e1 = decideLoginWedgeRecovery(WEDGED, capped, t0 + T.cooldownMs, T)
    expect(e1.action).toBe('escalate')
    expect(e1.next.escalationCount).toBe(1)
    // Escalation cap hit -> fall silent.
    const atEscCap = { ...capped, escalationCount: T.maxEscalations, lastActionAtMs: t0 }
    const silent = decideLoginWedgeRecovery(WEDGED, atEscCap, t0 + T.cooldownMs, T)
    expect(silent.action).toBe('none')
    expect(silent.reason).toMatch(/escalation cap/i)
  })

  it('clock skew: a future lastActionAtMs is treated as cooled-down, never stalls', () => {
    const confirmed = { consecutiveWedgeTicks: 2, lastActionAtMs: t0 + 10 * 60_000, relaunchCount: 0, escalationCount: 0 }
    const d = decideLoginWedgeRecovery(WEDGED, confirmed, t0, T) // now is BEFORE lastAction
    expect(d.action).toBe('recover')
  })

  it('re-arm: after the wedge clears, a fresh wedge recovers again', () => {
    // Reach the escalation-silent floor.
    const spent = { consecutiveWedgeTicks: 9, lastActionAtMs: t0, relaunchCount: T.maxRelaunches, escalationCount: T.maxEscalations }
    // A clear observation resets the spell.
    const cleared = decideLoginWedgeRecovery({ onLoginBox: false, inboxStuck: false }, spent, t0 + 60_000, T)
    expect(cleared.next).toEqual(CLEAN)
    // A new wedge then confirms + recovers from the clean slate.
    const [c1, c2] = run(WEDGED, 2, 60_000, cleared.next)
    expect(c1.action).toBe('none')
    expect(c2.action).toBe('recover')
  })
})
