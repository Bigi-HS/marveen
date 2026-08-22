import { describe, it, expect } from 'vitest'
import {
  classifyFreshness,
  assessReportedHealth,
  isActionable,
  DEFAULT_STALE_AFTER_MS,
} from '../web/watchdog-freshness.js'

const NOW = 1_700_000_000_000

describe('classifyFreshness', () => {
  it('null/undefined lastCheckedTs -> never-checked', () => {
    expect(classifyFreshness(null, NOW)).toBe('never-checked')
    expect(classifyFreshness(undefined, NOW)).toBe('never-checked')
  })

  it('a recent check is fresh', () => {
    expect(classifyFreshness(NOW - 60_000, NOW)).toBe('fresh')
  })

  it('a check exactly at the threshold is still fresh (boundary)', () => {
    expect(classifyFreshness(NOW - DEFAULT_STALE_AFTER_MS, NOW)).toBe('fresh')
  })

  it('a check older than the threshold is stale', () => {
    expect(classifyFreshness(NOW - DEFAULT_STALE_AFTER_MS - 1, NOW)).toBe('stale')
  })

  it('the 18h-blind-window case (hibiki 2026-06-22) is stale', () => {
    expect(classifyFreshness(NOW - 18 * 60 * 60 * 1000, NOW)).toBe('stale')
  })

  it('honours a custom staleAfterMs', () => {
    expect(classifyFreshness(NOW - 5_000, NOW, 1_000)).toBe('stale')
    expect(classifyFreshness(NOW - 500, NOW, 1_000)).toBe('fresh')
  })

  it('a future timestamp (clock skew) is treated as fresh, never stale', () => {
    expect(classifyFreshness(NOW + 10_000, NOW)).toBe('fresh')
  })
})

describe('assessReportedHealth', () => {
  it('fresh + zero dead -> healthy', () => {
    expect(assessReportedHealth({ consecutiveDead: 0, lastCheckedTs: NOW - 1_000, now: NOW })).toBe('healthy')
  })

  it('fresh + dead counter -> dead', () => {
    expect(assessReportedHealth({ consecutiveDead: 2, lastCheckedTs: NOW - 1_000, now: NOW })).toBe('dead')
  })

  // The core regression: a stale state with consecutiveDead===0 must NOT read
  // healthy. This is exactly the dead-pipe-but-stale-state-healthy false
  // negative that hid hibiki's dead pipe for ~18h.
  it('ADVERSARIAL: stale state with zero dead does NOT read healthy', () => {
    const verdict = assessReportedHealth({
      consecutiveDead: 0,
      lastCheckedTs: NOW - 18 * 60 * 60 * 1000,
      now: NOW,
    })
    expect(verdict).not.toBe('healthy')
    expect(verdict).toBe('stale')
  })

  it('never-checked state reads as unknown, not healthy', () => {
    const verdict = assessReportedHealth({ consecutiveDead: 0, lastCheckedTs: null, now: NOW })
    expect(verdict).not.toBe('healthy')
    expect(verdict).toBe('unknown')
  })

  it('staleness wins even when the cached counter looks dead', () => {
    // A stale state is untrustworthy regardless of its counter value.
    expect(
      assessReportedHealth({ consecutiveDead: 5, lastCheckedTs: NOW - 60 * 60 * 1000, now: NOW }),
    ).toBe('stale')
  })

  it('honours a custom staleAfterMs', () => {
    expect(
      assessReportedHealth({ consecutiveDead: 0, lastCheckedTs: NOW - 2_000, now: NOW, staleAfterMs: 1_000 }),
    ).toBe('stale')
  })
})

describe('isActionable', () => {
  it('only healthy is non-actionable', () => {
    expect(isActionable('healthy')).toBe(false)
    expect(isActionable('dead')).toBe(true)
    expect(isActionable('stale')).toBe(true)
    expect(isActionable('unknown')).toBe(true)
  })
})
