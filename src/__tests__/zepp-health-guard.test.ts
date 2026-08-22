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

  it('raises partial alert when status is partial', () => {
    const alerts = checkSnapshot(snap({ status: 'partial', error: 'sleep endpoint 429' }), BASE_NOW_MS)
    expect(alerts.some((a) => a.type === 'partial')).toBe(true)
  })

  it('alert includes the snapshot date', () => {
    const alerts = checkSnapshot(snap({ status: 'auth_fail' }), BASE_NOW_MS)
    expect(alerts[0].date).toBe('2026-08-22')
  })
})
