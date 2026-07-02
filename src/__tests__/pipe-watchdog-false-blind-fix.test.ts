// Adversarial fixture for card 2f0298cf -- pipe-watchdog false-blind fix.
//
// PROBLEM: probeTelegramConflict (PROBE_TIMEOUT_MS=4000) aborts before Telegram
// responds. status=0 + present=true → assessPipeLiveness returns 'inconclusive'
// → nextState is a no-op → watchdog state FREEZES (consecutiveDead never resets,
// lastHealthyTs never advances), so auto-recovery is effectively disabled even
// though the pipe is ALIVE.
//
// TARGET FIX (Dave, 2 changes):
//   1. channel-conflict-probe.ts: PROBE_TIMEOUT_MS 4000 → 15000 (or similar)
//      so the 409 can actually arrive before the abort.
//   2. telegram-pipe-watchdog.ts, assessPipeLiveness: add
//        if (facts.present === true && facts.probeStatus === 0) return 'healthy'
//      BEFORE the final `return 'inconclusive'`.
//      Rationale: a running process IS the pipe structurally; 200 (slot-free)
//      remains the hard dead-signal; abort-while-present is not a real failure.
//
// FIXTURE STRUCTURE:
//   - [PASSING NOW] real-dead cases: present=false → dead (unchanged by fix).
//   - [PASSING NOW] slot-free dead: present=true, status=200 → dead (unchanged).
//   - [PASSING NOW] confirmed-healthy: present=true, status=409 → healthy (unchanged).
//   - [TODO → will pass after fix] false-blind: present=true, status=0 → healthy.
//   - [TODO → will pass after fix] frozen-state recovery when present=true, status=0.

import { describe, it, expect } from 'vitest'
import {
  assessPipeLiveness,
  nextState,
  INITIAL_STATE,
  type WatchdogState,
} from '../web/telegram-pipe-watchdog.js'

// ---------------------------------------------------------------------------
// Real-dead cases -- these must pass BOTH before and after the fix.
// If these ever break, the fix regressed the death-detection path.
// ---------------------------------------------------------------------------

describe('real-dead detection [MUST pass before AND after 2f0298cf fix]', () => {
  it('present=false (process gone) is dead regardless of probe status', () => {
    expect(assessPipeLiveness({ present: false, conflicted: false, probeStatus: 0 })).toBe('dead')
    expect(assessPipeLiveness({ present: false, conflicted: false, probeStatus: 200 })).toBe('dead')
    expect(assessPipeLiveness({ present: false, conflicted: true, probeStatus: 409 })).toBe('dead')
  })

  it('slot-free (status=200) while present -> dead (pipe not polling)', () => {
    expect(assessPipeLiveness({ present: true, conflicted: false, probeStatus: 200 })).toBe('dead')
    expect(assessPipeLiveness({ present: null, conflicted: false, probeStatus: 200 })).toBe('dead')
  })

  it('nextState with dead verdict increments consecutiveDead', () => {
    const s = nextState(INITIAL_STATE, 'dead', 1000)
    expect(s.consecutiveDead).toBe(1)
    const s2 = nextState(s, 'dead', 2000)
    expect(s2.consecutiveDead).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Confirmed-healthy cases -- unchanged by fix.
// ---------------------------------------------------------------------------

describe('confirmed-healthy [MUST pass before AND after 2f0298cf fix]', () => {
  it('409 conflict with process present -> healthy', () => {
    expect(assessPipeLiveness({ present: true, conflicted: true, probeStatus: 409 })).toBe('healthy')
    expect(assessPipeLiveness({ present: null, conflicted: true, probeStatus: 409 })).toBe('healthy')
  })

  it('healthy verdict resets frozen state (consecutiveDead=3, alerted=true)', () => {
    const frozen: WatchdogState = { consecutiveDead: 3, alerted: true, lastHealthyTs: 1000 }
    const reset = nextState(frozen, 'healthy', 99999)
    expect(reset.consecutiveDead).toBe(0)
    expect(reset.alerted).toBe(false)
    expect(reset.lastHealthyTs).toBe(99999)
  })
})

// ---------------------------------------------------------------------------
// False-blind cases -- currently 'inconclusive' (BUG), should be 'healthy'.
// These are the REGRESSION TARGETS for the fix.
//
// Convert it.todo → it once assessPipeLiveness is patched:
//   if (facts.present === true && facts.probeStatus === 0) return 'healthy'
// ---------------------------------------------------------------------------

describe('false-blind fix [TODO: convert to it() after fix lands]', () => {
  it.todo(
    'present=true, status=0 (probe aborted) → should be healthy (process running = pipe alive)',
    // Uncomment after fix:
    // () => {
    //   expect(assessPipeLiveness({ present: true, conflicted: false, probeStatus: 0 })).toBe('healthy')
    // }
  )

  it.todo(
    'frozen state (consecutiveDead=3, alerted=true) resets when present=true, status=0',
    // Uncomment after fix:
    // () => {
    //   const frozen: WatchdogState = { consecutiveDead: 3, alerted: true, lastHealthyTs: 1000 }
    //   // With fix: assessPipeLiveness({present:true, status:0}) = healthy
    //   const reset = nextState(frozen, 'healthy', 99999)  // simulate what the cycle now gets
    //   expect(reset.consecutiveDead).toBe(0)
    //   expect(reset.alerted).toBe(false)
    //   expect(reset.lastHealthyTs).toBe(99999)
    // }
  )

  it.todo(
    'present=null (presence unknown), status=0 → inconclusive STILL (unknown process state is not a safe healthy signal)',
    // This case stays inconclusive even after the fix:
    // assessPipeLiveness({ present: null, conflicted: false, probeStatus: 0 }) === 'inconclusive'
    // Only present===true is safe to treat as healthy on abort.
  )

  it.todo(
    'PROBE_TIMEOUT_MS should be raised to allow 409 to arrive before abort',
    // After fix: PROBE_TIMEOUT_MS >= 12000 in channel-conflict-probe.ts:30.
    // import { PROBE_TIMEOUT_MS } from '../web/channel-conflict-probe.js' -- if exported
    // expect(PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(12000)
  )
})

// ---------------------------------------------------------------------------
// State-machine invariants -- must hold regardless of fix.
// ---------------------------------------------------------------------------

describe('state machine invariants', () => {
  it('inconclusive verdict is a pure no-op on state', () => {
    const frozen: WatchdogState = { consecutiveDead: 3, alerted: true, lastHealthyTs: 1000 }
    const after = nextState(frozen, 'inconclusive', 99999)
    expect(after).toBe(frozen)  // same reference -- no allocation
  })

  it('dead verdict never changes alerted flag (shouldEscalate handles that)', () => {
    const s = nextState(INITIAL_STATE, 'dead', 1000)
    expect(s.alerted).toBe(false)  // alerted stays false until shouldEscalate fires
  })
})
