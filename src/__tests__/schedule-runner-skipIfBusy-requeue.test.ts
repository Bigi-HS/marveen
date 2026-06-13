// Unit tests for skipIfBusy bounded re-queue (card 92f763a2).
//
// The schedule-runner is tightly coupled to tmux and the live DB so we test
// the pure decision logic here: throttle and cap predicates. Integration of
// the full retry loop is covered by the existing pending-retries tests and
// the manual c12 harness.

import { describe, it, expect } from 'vitest'
import {
  SKIP_IF_BUSY_MAX_RETRIES,
  SKIP_IF_BUSY_RETRY_INTERVAL_MS,
} from '../web/schedule-runner.js'

// Pure helpers extracted for testing (mirrors the in-runner logic).
function isThrottled(lastAttemptMs: number, nowMs: number): boolean {
  return nowMs - lastAttemptMs < SKIP_IF_BUSY_RETRY_INTERVAL_MS
}

function isExhausted(attemptCount: number, newCountAfterUpdate: number): boolean {
  return newCountAfterUpdate > SKIP_IF_BUSY_MAX_RETRIES
}

describe('SKIP_IF_BUSY constants', () => {
  it('max retries is 3', () => {
    expect(SKIP_IF_BUSY_MAX_RETRIES).toBe(3)
  })

  it('retry interval is 10 minutes in ms', () => {
    expect(SKIP_IF_BUSY_RETRY_INTERVAL_MS).toBe(10 * 60 * 1000)
  })
})

describe('isThrottled (10-min spacing)', () => {
  const t0 = 1_000_000_000_000

  it('true when no time has elapsed', () => {
    expect(isThrottled(t0, t0)).toBe(true)
  })

  it('true when 9m59s has elapsed (just under 10min)', () => {
    expect(isThrottled(t0, t0 + 9 * 60 * 1000 + 59_000)).toBe(true)
  })

  it('false exactly at 10 minutes', () => {
    expect(isThrottled(t0, t0 + SKIP_IF_BUSY_RETRY_INTERVAL_MS)).toBe(false)
  })

  it('false when more than 10 minutes have elapsed', () => {
    expect(isThrottled(t0, t0 + 11 * 60 * 1000)).toBe(false)
  })
})

describe('isExhausted (attempt cap)', () => {
  it('false after 1st retry (count becomes 2)', () => {
    expect(isExhausted(1, 2)).toBe(false)
  })

  it('false after 2nd retry (count becomes 3)', () => {
    expect(isExhausted(2, 3)).toBe(false)
  })

  it('true after 3rd retry (count becomes 4 > max 3)', () => {
    expect(isExhausted(3, 4)).toBe(true)
  })

  it('true for any count beyond max', () => {
    expect(isExhausted(10, 11)).toBe(true)
  })
})

describe('bounded retry lifecycle (state trace)', () => {
  // Simulate the in-runner state transitions without any I/O.
  // State: { last_attempt, attempt_count }
  const INTERVAL = SKIP_IF_BUSY_RETRY_INTERVAL_MS
  const MAX = SKIP_IF_BUSY_MAX_RETRIES

  function tick(state: { last_attempt: number; attempt_count: number }, now: number):
    { action: 'throttle' | 'retry' | 'exhausted'; nextState?: { last_attempt: number; attempt_count: number } } {
    if (isThrottled(state.last_attempt, now)) return { action: 'throttle', nextState: state }
    const newCount = state.attempt_count + 1
    if (isExhausted(state.attempt_count, newCount)) return { action: 'exhausted' }
    return { action: 'retry', nextState: { last_attempt: now, attempt_count: newCount } }
  }

  it('first 9 ticks (60s each) are throttled', () => {
    let state = { last_attempt: 0, attempt_count: 1 }
    for (let i = 1; i <= 9; i++) {
      const result = tick(state, i * 60_000)
      expect(result.action).toBe('throttle')
    }
  })

  it('10th tick (600s = 10min) fires retry #1', () => {
    const state = { last_attempt: 0, attempt_count: 1 }
    const result = tick(state, 10 * 60_000)
    expect(result.action).toBe('retry')
    expect(result.nextState?.attempt_count).toBe(2)
  })

  it('full lifecycle: 3 attempts then exhausted (max 3x@10min)', () => {
    // attempt_count starts at 1 (initial queue in cron loop).
    // Retry loop attempts at each 10-min interval; the 3rd attempt still
    // busy → exhausted (action='exhausted' means: attempted, was busy, cap hit).
    // Total busy encounters: 3 (including this final one) = "max 3x".
    let state = { last_attempt: 0, attempt_count: 1 }
    const actions: string[] = []
    for (let tick_n = 1; tick_n <= 4; tick_n++) {
      const now = tick_n * INTERVAL
      const result = tick(state, now)
      actions.push(result.action)
      if (result.nextState) state = result.nextState
      if (result.action === 'exhausted') break
    }
    expect(actions).toEqual(['retry', 'retry', 'exhausted'])
  })

  it('session frees up before exhaustion: fired mid-retry', () => {
    // Simulate: queued at t=0, still busy at t=10m, free at t=20m
    const state1 = { last_attempt: 0, attempt_count: 1 }
    const r1 = tick(state1, INTERVAL)
    expect(r1.action).toBe('retry')
    // t=20min: fired (session free) -- just check we got to retry stage
    expect(r1.nextState?.attempt_count).toBe(2)
    // The fired path in the runner deletes the row; no further state needed.
  })
})
