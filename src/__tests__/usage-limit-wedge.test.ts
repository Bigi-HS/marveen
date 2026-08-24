import { describe, it, expect } from 'vitest'
import {
  decideUsageLimitRecovery,
  DEFAULT_USAGE_LIMIT_WEDGE_THRESHOLDS,
  type UsageLimitWedgeState,
  type UsageLimitWedgeThresholds,
} from '../web/usage-limit-wedge.js'

// Pure decision core for usage-limit-modal auto-recovery of a wedged agent.
// The wedge = a tmux session + MCP plugin child both alive, but the Claude Code
// brain frozen on the blocking "Stop and wait for limit to reset" modal, which is
// STICKY (does not self-dismiss on reset). The host loop injects a per-tick
// `modalDetected` (from detectsUsageLimitMenu on the captured pane) and a clock;
// this decides whether to restart. These tests pin the confirm-window,
// cooldown, restart-cap and escalation behaviour AND the adversarial
// false-positive cases the gate requires -- an over-eager detector would nuke a
// healthy agent that merely rendered the modal text for one capture frame.

const T: UsageLimitWedgeThresholds = DEFAULT_USAGE_LIMIT_WEDGE_THRESHOLDS
const FRESH: UsageLimitWedgeState = {
  consecutiveModalTicks: 0,
  lastRestartAtMs: null,
  restartCount: 0,
  escalationCount: 0,
}
const NOW = 1_000_000_000_000
const MIN = 60_000

describe('decideUsageLimitRecovery -- confirm window (false-positive guard)', () => {
  it('does NOT restart on the first modal sighting -- records only', () => {
    const d = decideUsageLimitRecovery(true, FRESH, NOW, T)
    expect(d.action).toBe('none')
    expect(d.next.consecutiveModalTicks).toBe(1)
    expect(d.next.restartCount).toBe(0)
    expect(d.next.lastRestartAtMs).toBeNull()
  })

  it('restarts once the modal persists for confirmTicks consecutive observations', () => {
    // confirmTicks defaults to 2: a single glitch frame never fires.
    const afterFirst = decideUsageLimitRecovery(true, FRESH, NOW, T).next
    const d = decideUsageLimitRecovery(true, afterFirst, NOW + MIN, T)
    expect(d.action).toBe('recover')
    expect(d.next.restartCount).toBe(1)
    expect(d.next.lastRestartAtMs).toBe(NOW + MIN)
  })

  it('resets the confirm streak when a clear observation interrupts it', () => {
    // modal, then a clear frame, then modal again -> the new modal is a FIRST
    // sighting again, not the second half of the earlier streak.
    const afterFirst = decideUsageLimitRecovery(true, FRESH, NOW, T).next
    const afterClear = decideUsageLimitRecovery(false, afterFirst, NOW + MIN, T).next
    expect(afterClear.consecutiveModalTicks).toBe(0)
    const d = decideUsageLimitRecovery(true, afterClear, NOW + 2 * MIN, T)
    expect(d.action).toBe('none') // only the 1st consecutive sighting again
    expect(d.next.consecutiveModalTicks).toBe(1)
  })
})

describe('decideUsageLimitRecovery -- healthy / cleared', () => {
  it('returns none and clean state when no modal is present', () => {
    const d = decideUsageLimitRecovery(false, FRESH, NOW, T)
    expect(d.action).toBe('none')
    expect(d.next).toEqual(FRESH)
  })

  it('clears an active spell (resets counters) when the modal disappears', () => {
    const spell: UsageLimitWedgeState = {
      consecutiveModalTicks: 3,
      lastRestartAtMs: NOW - MIN,
      restartCount: 2,
      escalationCount: 0,
    }
    const d = decideUsageLimitRecovery(false, spell, NOW, T)
    expect(d.action).toBe('none')
    expect(d.next.consecutiveModalTicks).toBe(0)
    expect(d.next.restartCount).toBe(0)
    expect(d.next.lastRestartAtMs).toBeNull()
  })
})

describe('decideUsageLimitRecovery -- cooldown throttle', () => {
  it('waits when a confirmed modal is still within the restart cooldown', () => {
    const state: UsageLimitWedgeState = {
      consecutiveModalTicks: 2,
      lastRestartAtMs: NOW,
      restartCount: 1,
      escalationCount: 0,
    }
    const d = decideUsageLimitRecovery(true, state, NOW + MIN, T) // cooldown is minutes
    expect(d.action).toBe('wait')
    // the tick counter still advances so we know the modal is persisting
    expect(d.next.consecutiveModalTicks).toBe(3)
    expect(d.next.restartCount).toBe(1)
  })

  it('restarts again after the cooldown elapses if the modal is still up', () => {
    const state: UsageLimitWedgeState = {
      consecutiveModalTicks: 2,
      lastRestartAtMs: NOW,
      restartCount: 1,
      escalationCount: 0,
    }
    const d = decideUsageLimitRecovery(true, state, NOW + T.cooldownMs + 1, T)
    expect(d.action).toBe('recover')
    expect(d.next.restartCount).toBe(2)
    expect(d.next.lastRestartAtMs).toBe(NOW + T.cooldownMs + 1)
  })
})

describe('decideUsageLimitRecovery -- restart cap escalates to the operator', () => {
  it('escalates instead of restarting once maxRestarts is reached', () => {
    // A genuinely-active (non-stale) limit re-hits the modal on every fresh
    // session; the cap stops an infinite restart storm and hands off to a human.
    const state: UsageLimitWedgeState = {
      consecutiveModalTicks: 5,
      lastRestartAtMs: NOW,
      restartCount: T.maxRestarts,
      escalationCount: 0,
    }
    const d = decideUsageLimitRecovery(true, state, NOW + T.cooldownMs + 1, T)
    expect(d.action).toBe('escalate')
    expect(d.next.escalationCount).toBe(1)
    expect(d.next.restartCount).toBe(T.maxRestarts) // not incremented past the cap
  })

  it('falls silent after maxEscalations to avoid alert spam', () => {
    const state: UsageLimitWedgeState = {
      consecutiveModalTicks: 5,
      lastRestartAtMs: NOW,
      restartCount: T.maxRestarts,
      escalationCount: T.maxEscalations,
    }
    const d = decideUsageLimitRecovery(true, state, NOW + T.cooldownMs + 1, T)
    expect(d.action).toBe('none')
    expect(d.next.escalationCount).toBe(T.maxEscalations)
  })
})

describe('decideUsageLimitRecovery -- clock-skew robustness', () => {
  it('treats a future-dated lastRestartAtMs as cooldown-elapsed (does not stall)', () => {
    const state: UsageLimitWedgeState = {
      consecutiveModalTicks: 2,
      lastRestartAtMs: NOW + 10 * MIN, // stored timestamp in the future (NTP correction)
      restartCount: 1,
      escalationCount: 0,
    }
    const d = decideUsageLimitRecovery(true, state, NOW, T)
    expect(d.action).toBe('recover')
    expect(d.next.lastRestartAtMs).toBe(NOW)
  })
})
