import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  isBusyToIdleTransition,
  checkIdlePipeRecovery,
  clearIdlePipeRecoveryAgent,
  __setIdlePipeRecoveryDeps,
  __resetIdlePipeRecoveryDeps,
  __resetIdlePipeRecoveryState,
} from '../web/idle-pipe-recovery.js'
import type { PaneState } from '../pane-state.js'
import type { ProcEnvScan } from '../web/channel-poller-reap.js'

// Card 667281e4: adversarial fixtures for the busy->idle pipe-recovery trigger.
// FALSE-NEGATIVE guard: a real turn-end (busy->idle) MUST hand off to recovery.
// FALSE-POSITIVE guard: a working agent merely idling between turns (idle->idle,
// or a first observation) must NEVER trigger a recovery probe.
describe('isBusyToIdleTransition (pure edge detector)', () => {
  it('fires only on a genuine busy->idle edge (false-negative guard)', () => {
    expect(isBusyToIdleTransition('busy', 'idle')).toBe(true)
  })

  it('does not fire on non-edges (false-positive guards)', () => {
    expect(isBusyToIdleTransition('idle', 'idle')).toBe(false) // agent already idle between turns
    expect(isBusyToIdleTransition(null, 'idle')).toBe(false) // first observation, not a transition
    expect(isBusyToIdleTransition('busy', 'busy')).toBe(false)
    expect(isBusyToIdleTransition('idle', 'busy')).toBe(false)
    expect(isBusyToIdleTransition('typing', 'idle')).toBe(false)
    expect(isBusyToIdleTransition('unknown', 'idle')).toBe(false)
    expect(isBusyToIdleTransition('error', 'idle')).toBe(false)
  })
})

describe('checkIdlePipeRecovery wiring (card 667281e4)', () => {
  let recover: ReturnType<typeof vi.fn>
  let currentState: PaneState
  const PS = { sentinel: true } as unknown as ProcEnvScan

  beforeEach(() => {
    __resetIdlePipeRecoveryState()
    recover = vi.fn()
    currentState = 'unknown'
    __setIdlePipeRecoveryDeps({
      detect: () => currentState,
      recover: (a, p, ps) => recover(a, p, ps),
      getPsScan: () => PS,
    })
  })

  afterEach(() => {
    __resetIdlePipeRecoveryDeps()
    __resetIdlePipeRecoveryState()
  })

  it('hands off to recovery on busy->idle with the pane + psScan (FN)', () => {
    currentState = 'busy'
    checkIdlePipeRecovery('samu', 'PANE_BUSY')
    expect(recover).not.toHaveBeenCalled() // first obs only records prev=busy

    currentState = 'idle'
    checkIdlePipeRecovery('samu', 'PANE_IDLE')
    expect(recover).toHaveBeenCalledTimes(1)
    expect(recover).toHaveBeenCalledWith('samu', 'PANE_IDLE', PS)
  })

  it('never probes an agent idling between turns (FP: idle->idle)', () => {
    currentState = 'idle'
    checkIdlePipeRecovery('samu', 'p') // null -> idle
    checkIdlePipeRecovery('samu', 'p') // idle -> idle
    checkIdlePipeRecovery('samu', 'p') // idle -> idle
    expect(recover).not.toHaveBeenCalled()
  })

  it('fires once per edge, not every tick while idle', () => {
    currentState = 'busy'
    checkIdlePipeRecovery('samu', 'p')
    currentState = 'idle'
    checkIdlePipeRecovery('samu', 'p') // edge -> 1
    checkIdlePipeRecovery('samu', 'p') // still idle -> no
    checkIdlePipeRecovery('samu', 'p')
    expect(recover).toHaveBeenCalledTimes(1)

    currentState = 'busy'
    checkIdlePipeRecovery('samu', 'p') // back to busy
    currentState = 'idle'
    checkIdlePipeRecovery('samu', 'p') // new edge -> 2
    expect(recover).toHaveBeenCalledTimes(2)
  })

  it('tracks state per agent', () => {
    currentState = 'busy'
    checkIdlePipeRecovery('a', 'p')
    currentState = 'idle'
    checkIdlePipeRecovery('a', 'p') // a: edge
    expect(recover).toHaveBeenCalledTimes(1)
    checkIdlePipeRecovery('b', 'p') // b: null -> idle, no edge
    expect(recover).toHaveBeenCalledTimes(1)
  })

  it('clearIdlePipeRecoveryAgent forgets prior state so a restart is not read as an edge', () => {
    currentState = 'busy'
    checkIdlePipeRecovery('samu', 'p')
    clearIdlePipeRecoveryAgent('samu')
    currentState = 'idle'
    checkIdlePipeRecovery('samu', 'p') // null -> idle after clear, no edge
    expect(recover).not.toHaveBeenCalled()
  })
})
