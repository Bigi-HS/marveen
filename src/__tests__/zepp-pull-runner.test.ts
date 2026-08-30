import { describe, it, expect, vi } from 'vitest'
import { runZeppPull, type PullRunnerDeps } from '../web/zepp/pull-runner.js'
import type { ZeppSleep, ZeppVitals, ZeppWorkout, ZeppDailySnapshot } from '../web/zepp/contract.js'

const SLEEP: ZeppSleep = { durationMin: 420, startAt: '2026-08-21T23:00:00Z', endAt: '2026-08-22T06:00:00Z', score: 80 }
const VITALS: ZeppVitals = { restingHr: 58, spo2: 97, hrv: 42 }
const WORKOUTS: ZeppWorkout[] = [{ type: 'outdoor_running', startAt: '2026-08-22T07:00:00Z', durationSec: 1800 }]

function makeDeps(over: Partial<PullRunnerDeps> = {}): PullRunnerDeps {
  return {
    readCreds: vi.fn(async () => ({ email: 'user@test.com', password: 'pass' })),
    login: vi.fn(async () => ({ accessToken: 'acc', refreshToken: 'ref', expiresAt: Date.now() + 3600_000 })),
    pullSleep: vi.fn(async () => SLEEP),
    pullVitals: vi.fn(async () => VITALS),
    pullWorkouts: vi.fn(async () => WORKOUTS),
    writeSnapshot: vi.fn(),
    recordAnomaly: vi.fn(),
    onAlerts: vi.fn(),
    nowIso: () => '2026-08-22T10:00:00.000Z',
    ...over,
  }
}

describe('runZeppPull', () => {
  it('returns ok snapshot with sleep, vitals, workouts on happy path', async () => {
    const deps = makeDeps()
    const snap = await runZeppPull('2026-08-22', deps)
    expect(snap.status).toBe('ok')
    expect(snap.sleep).toEqual(SLEEP)
    expect(snap.vitals).toEqual(VITALS)
    expect(snap.workouts).toEqual(WORKOUTS)
    expect(snap.date).toBe('2026-08-22')
    expect(snap.pulledAt).toBe('2026-08-22T10:00:00.000Z')
  })

  it('writes snapshot to store', async () => {
    const deps = makeDeps()
    const snap = await runZeppPull('2026-08-22', deps)
    expect(deps.writeSnapshot).toHaveBeenCalledWith(snap)
  })

  it('partial when only sleep missing', async () => {
    const deps = makeDeps({ pullSleep: vi.fn(async () => null) })
    const snap = await runZeppPull('2026-08-22', deps)
    expect(snap.status).toBe('partial')
    expect(snap.sleep).toBeUndefined()
    expect(snap.vitals).toEqual(VITALS)
  })

  it('auth_fail snapshot when login throws auth_fail', async () => {
    const err = Object.assign(new Error('invalid creds'), { type: 'auth_fail' })
    const deps = makeDeps({ login: vi.fn(async () => { throw err }) })
    const snap = await runZeppPull('2026-08-22', deps)
    expect(snap.status).toBe('auth_fail')
    expect(snap.error).toBeTruthy()
  })

  it('calls onAlerts with health-guard results', async () => {
    const err = Object.assign(new Error('invalid creds'), { type: 'auth_fail' })
    const deps = makeDeps({ login: vi.fn(async () => { throw err }) })
    await runZeppPull('2026-08-22', deps)
    expect(deps.onAlerts).toHaveBeenCalled()
    const alerts = (deps.onAlerts as any).mock.calls[0][0]
    expect(alerts.some((a: any) => a.type === 'auth_fail')).toBe(true)
  })

  it('endpoint_error snapshot when a pull endpoint throws', async () => {
    const err = Object.assign(new Error('HTTP 503'), { type: 'endpoint_error' })
    const deps = makeDeps({ pullSleep: vi.fn(async () => { throw err }) })
    const snap = await runZeppPull('2026-08-22', deps)
    expect(snap.status).toBe('endpoint_error')
  })

  it('snapshot is written even on auth_fail (silent-guard: broken pull never invisible)', async () => {
    const err = Object.assign(new Error('bad'), { type: 'auth_fail' })
    const deps = makeDeps({ login: vi.fn(async () => { throw err }) })
    await runZeppPull('2026-08-22', deps)
    expect(deps.writeSnapshot).toHaveBeenCalledTimes(1)
    expect((deps.writeSnapshot as any).mock.calls[0][0].status).toBe('auth_fail')
  })

  // WELL-027 WS1: the pull path must persist an anomaly flag, not just log it. Rule 4
  // (heart-rate sanity) fires on vitals -- a field the pull writes -- so an implausible
  // vitals pull is the reproducer for the guard-only-as-good-as-its-wiring gap.
  it('persists a suspect anomaly when pulled vitals are implausible (restingHr >= hrAvg)', async () => {
    const badVitals: ZeppVitals = { restingHr: 80, hrAvg: 74, hrMax: 150 }
    const deps = makeDeps({ pullVitals: vi.fn(async () => badVitals) })
    await runZeppPull('2026-08-25', deps)
    expect(deps.recordAnomaly).toHaveBeenCalledTimes(1)
    const [date, suspect] = (deps.recordAnomaly as any).mock.calls[0]
    expect(date).toBe('2026-08-25')
    expect(suspect.some((v: any) => v.rule === 'heart rate ordering')).toBe(true)
    expect(suspect.every((v: any) => v.severity === 'suspect')).toBe(true)
  })

  it('records an empty anomaly list on a clean pull so an open flag can resolve', async () => {
    const deps = makeDeps()
    await runZeppPull('2026-08-22', deps)
    expect(deps.recordAnomaly).toHaveBeenCalledWith('2026-08-22', [])
  })

  it('writes the snapshot before recording its anomaly (durability ordering)', async () => {
    const order: string[] = []
    const deps = makeDeps({
      writeSnapshot: vi.fn(() => { order.push('write') }),
      recordAnomaly: vi.fn(() => { order.push('record') }),
    })
    await runZeppPull('2026-08-22', deps)
    expect(order).toEqual(['write', 'record'])
  })
})
