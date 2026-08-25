import { describe, it, expect } from 'vitest'
import { checkSnapshot, type HealthGuardAlert } from '../web/zepp/health-guard.js'
import type { ZeppDailySnapshot } from '../web/zepp/contract.js'

const BASE_NOW_MS = new Date('2026-08-22T10:00:00Z').getTime()

function snap(over: Partial<ZeppDailySnapshot>): ZeppDailySnapshot {
  return {
    date: '2026-08-22',
    pulledAt: '2026-08-22T09:00:00.000Z',
    status: 'ok',
    ...over,
  }
}

describe('checkSnapshot', () => {
  it('returns no alerts for a healthy ok snapshot', () => {
    expect(checkSnapshot(snap({ status: 'ok' }), BASE_NOW_MS)).toHaveLength(0)
  })

  it('raises auth_fail alert', () => {
    const alerts = checkSnapshot(snap({ status: 'auth_fail', error: 'invalid credentials' }), BASE_NOW_MS)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].type).toBe('auth_fail')
    expect(alerts[0].message).toMatch(/auth/)
  })

  it('raises endpoint_error alert', () => {
    const alerts = checkSnapshot(snap({ status: 'endpoint_error', error: 'HTTP 503' }), BASE_NOW_MS)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].type).toBe('endpoint_error')
  })

  it('raises stale alert when pulledAt is >26h ago', () => {
    const staleMs = BASE_NOW_MS - 27 * 60 * 60 * 1000
    const alerts = checkSnapshot(
      snap({ status: 'ok', pulledAt: new Date(staleMs).toISOString() }),
      BASE_NOW_MS,
    )
    expect(alerts.some((a) => a.type === 'stale')).toBe(true)
  })

  it('does NOT raise stale alert when pulledAt is <26h ago', () => {
    const freshMs = BASE_NOW_MS - 10 * 60 * 60 * 1000
    const alerts = checkSnapshot(
      snap({ status: 'ok', pulledAt: new Date(freshMs).toISOString() }),
      BASE_NOW_MS,
    )
    expect(alerts.some((a) => a.type === 'stale')).toBe(false)
  })

  // ENG-084: literal boundary pin for the 26h staleness threshold. Without these,
  // the 10h-fresh / 27h-stale pair leaves the boundary unconstrained anywhere in
  // (10h, 27h] -- a mutation to e.g. 20h passes every other test silently.
  const STALE_THRESHOLD_MS = 26 * 60 * 60 * 1000 // literal fixture, must equal the module constant

  it('is fresh at exactly 26h (threshold is strict >, not >=)', () => {
    const atBoundary = BASE_NOW_MS - STALE_THRESHOLD_MS
    const alerts = checkSnapshot(
      snap({ status: 'ok', pulledAt: new Date(atBoundary).toISOString() }),
      BASE_NOW_MS,
    )
    expect(alerts.some((a) => a.type === 'stale')).toBe(false)
  })

  it('is stale just past 26h (1s over the threshold)', () => {
    const justOver = BASE_NOW_MS - (STALE_THRESHOLD_MS + 1000)
    const alerts = checkSnapshot(
      snap({ status: 'ok', pulledAt: new Date(justOver).toISOString() }),
      BASE_NOW_MS,
    )
    expect(alerts.some((a) => a.type === 'stale')).toBe(true)
  })

  it('raises partial alert when status is partial', () => {
    const alerts = checkSnapshot(snap({ status: 'partial', error: 'sleep endpoint 429' }), BASE_NOW_MS)
    expect(alerts.some((a) => a.type === 'partial')).toBe(true)
  })

  it('raises stale alert when status is explicitly stale with fresh pulledAt (kidd blocking bug)', () => {
    // status='stale' + fresh pulledAt must NOT silently pass.
    // The API marking data as stale is a distinct signal from pulledAt-based staleness.
    const freshPulledAt = new Date(BASE_NOW_MS - 60 * 60 * 1000).toISOString() // 1h ago
    const alerts = checkSnapshot(snap({ status: 'stale', pulledAt: freshPulledAt }), BASE_NOW_MS)
    expect(alerts.some((a) => a.type === 'stale')).toBe(true)
  })

  it('alert includes the snapshot date', () => {
    const alerts = checkSnapshot(snap({ status: 'auth_fail' }), BASE_NOW_MS)
    expect(alerts[0].date).toBe('2026-08-22')
  })

  // card 75337cdc: numeric-plausibility 'suspect' alerts (log-only rollout).
  describe('plausibility (suspect)', () => {
    it('raises a suspect alert for physically impossible activity (live 08-25 bug)', () => {
      const alerts = checkSnapshot(
        snap({ status: 'ok', steps: 15790, activity: { activeKcal: 5, distanceM: 456 } }),
        BASE_NOW_MS,
      )
      const suspect = alerts.find((a) => a.type === 'suspect')
      expect(suspect).toBeDefined()
      expect(suspect!.date).toBe('2026-08-22')
    })

    it('does NOT raise a suspect alert for a coherent day', () => {
      const alerts = checkSnapshot(
        snap({ status: 'ok', steps: 13694, activity: { activeKcal: 1011, distanceM: 12040 } }),
        BASE_NOW_MS,
      )
      expect(alerts.some((a) => a.type === 'suspect')).toBe(false)
    })

    it('a healthy ok snapshot with no numeric data stays alert-free', () => {
      expect(checkSnapshot(snap({ status: 'ok' }), BASE_NOW_MS)).toHaveLength(0)
    })
  })
})
