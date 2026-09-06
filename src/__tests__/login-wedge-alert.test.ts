import { describe, it, expect } from 'vitest'
import {
  detectsActiveLoginBox,
  decideSustainedPaneAlert,
  decidePaneErrorAlert,
  type SustainedPaneAlertState,
  type SustainedPaneAlertThresholds,
} from '../pane-state.js'

// SLICE 1 (ba53fdee) log-only login-wedge alerting. The G3 detector
// (detectsActiveLoginBox, PR #636) shipped tested but UNWIRED -- dead code. This
// suite guards the WIRING contract the channel-monitor relies on: an active
// OAuth login-box, sustained across monitor ticks, drives ONE operator alert
// (confirm + dedup), clears when the box closes, and re-arms for the next wedge.
// It is alert-only -- no recovery/relaunch decision lives here (that is SLICE 2,
// c12 + Forge gated).

const SEP = '─'.repeat(80)

// Active OAuth login-box (both AND-markers in the last 10 lines) -- the pane an
// agent is wedged on. Same byte-shape as the merged G3 fixtures.
const LOGIN_ACTIVE = [
  '  Opening browser to sign in…',
  '  If the browser didn’t open, visit: https://claude.ai/oauth/authorize?code_challenge=AbCdEf1234567890XyZ&client_id=22422756-60c9-4084-8eb7-27705fd5cf9a&redirect_uri=http%3A%2F%2Flocalhost%3A8205%2Foauth%2Fcode%2Fcallback',
  '  Paste code here if prompted > ',
  '  Esc to cancel',
].join('\n')

// A healthy idle pane whose footer literally contains "gh auth login" -- proves
// the detector (and thus the alert gate) does NOT fire on the onboarding tip.
const IDLE_HEALTHY = [
  '  Summary: no blocking issues found.',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · gh auth login · ← for agents',
].join('\n')

// Mirror the channel-monitor calibration (60s tick, confirm=2 ticks).
const TICK_MS = 60_000
const TH: SustainedPaneAlertThresholds = {
  confirmMs: 120_000,
  dedupMs: 30 * 60 * 1000,
  clearMs: 5 * 60 * 1000,
}
const CLEAN: SustainedPaneAlertState = { firstSeenAt: null, lastAlertAt: null, lastErrorAt: null }

// Drive one monitor tick: detect on the pane, run the alert gate, return the
// decision + next state exactly as the wiring will.
function tick(pane: string, prev: SustainedPaneAlertState, now: number) {
  const onLoginBox = detectsActiveLoginBox(pane)
  return decideSustainedPaneAlert(onLoginBox, prev, now, TH)
}

describe('login-wedge alert gate reuses the sustained-pane-condition machine', () => {
  it('decideSustainedPaneAlert is the (tested) generic gate, aliased for readability', () => {
    expect(decideSustainedPaneAlert).toBe(decidePaneErrorAlert)
  })
})

describe('login-wedge alert integration (ba53fdee SLICE 1, log-only)', () => {
  it('a healthy idle pane (with gh-auth-login footer) never alerts', () => {
    let state = CLEAN
    let now = 1_000_000
    for (let i = 0; i < 5; i++) {
      const d = tick(IDLE_HEALTHY, state, now)
      expect(d.alert).toBe(false)
      state = d.next
      now += TICK_MS
    }
    expect(state).toEqual(CLEAN)
  })

  it('a sustained login-wedge alerts once after the confirm window, then dedups', () => {
    let now = 1_000_000
    // t0: first sighting only records -- never alerts on first observation.
    let d = tick(LOGIN_ACTIVE, CLEAN, now)
    expect(d.alert).toBe(false)
    expect(d.next.firstSeenAt).toBe(now)

    // t+60s: still inside the 120s confirm window -> no alert yet.
    now += TICK_MS
    d = tick(LOGIN_ACTIVE, d.next, now)
    expect(d.alert).toBe(false)

    // t+120s: confirm window satisfied, first alert fires.
    now += TICK_MS
    d = tick(LOGIN_ACTIVE, d.next, now)
    expect(d.alert).toBe(true)
    expect(d.next.lastAlertAt).toBe(now)

    // t+180s: still wedged but inside the 30min dedup window -> quiet.
    now += TICK_MS
    d = tick(LOGIN_ACTIVE, d.next, now)
    expect(d.alert).toBe(false)
  })

  it('clears only after a sustained login-free gap, then re-arms for the next wedge', () => {
    // Bring a spell to the alerted state.
    let now = 1_000_000
    let d = tick(LOGIN_ACTIVE, CLEAN, now)
    now += TICK_MS
    d = tick(LOGIN_ACTIVE, d.next, now)
    now += TICK_MS
    d = tick(LOGIN_ACTIVE, d.next, now)
    expect(d.alert).toBe(true)

    // Box closes. One login-free tick (60s < 5min clear) must NOT drop the spell.
    now += TICK_MS
    d = tick(IDLE_HEALTHY, d.next, now)
    expect(d.alert).toBe(false)
    expect(d.next.firstSeenAt).not.toBeNull()

    // Sustained login-free past clearMs -> spell cleared.
    now += 5 * 60 * 1000
    d = tick(IDLE_HEALTHY, d.next, now)
    expect(d.next).toEqual(CLEAN)

    // A brand-new login-wedge re-arms: first sighting records, no stale alert.
    now += TICK_MS
    d = tick(LOGIN_ACTIVE, d.next, now)
    expect(d.alert).toBe(false)
    expect(d.next.firstSeenAt).toBe(now)
  })
})
