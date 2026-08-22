import { describe, it, expect, vi } from 'vitest'
import { pullSleep, pullVitals, pullWorkouts, type ZeppPullDeps } from '../web/zepp/puller.js'

function makeDeps(fetchResponse: object, status = 200): ZeppPullDeps {
  return {
    apiBaseUrl: 'https://api.example.com',
    accessToken: 'test-token',
    fetch: vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => fetchResponse,
    } as Response)),
  }
}

const SLEEP_RESPONSE = {
  data: {
    sleep_duration: 25200,
    start_time: 1724288400,
    stop_time: 1724313600,
    score: 82,
    sleep_stages: [
      { stage: 'DEEP', seconds: 5400 },
      { stage: 'REM', seconds: 7200 },
      { stage: 'LIGHT', seconds: 10800 },
      { stage: 'AWAKE', seconds: 1800 },
    ],
  },
}

const VITALS_RESPONSE = {
  data: {
    heart_rate_resting: 58,
    spo2: 97,
    hrv: 42,
    stress: 31,
  },
}

const WORKOUTS_RESPONSE = {
  data: [
    {
      type: 'outdoor_running',
      start_time: 1724313600,
      end_time: 1724316900,
      distance: 5200,
      avg_heart_rate: 148,
      calories: 380,
    },
  ],
}

describe('pullSleep', () => {
  it('maps server response to ZeppSleep', async () => {
    const deps = makeDeps(SLEEP_RESPONSE)
    const sleep = await pullSleep('2026-08-22', deps)
    expect(sleep).not.toBeNull()
    expect(sleep!.durationMin).toBe(420)
    expect(sleep!.score).toBe(82)
    expect(sleep!.stages?.deep).toBeGreaterThan(0)
  })

  it('returns null on 404 (no data for the day)', async () => {
    const deps = makeDeps({}, 404)
    expect(await pullSleep('2026-08-22', deps)).toBeNull()
  })

  it('throws endpoint_error on 5xx', async () => {
    const deps = makeDeps({}, 503)
    await expect(pullSleep('2026-08-22', deps)).rejects.toMatchObject({ type: 'endpoint_error' })
  })

  it('includes Authorization header with access token', async () => {
    const deps = makeDeps(SLEEP_RESPONSE)
    await pullSleep('2026-08-22', deps)
    const [, opts] = (deps.fetch as any).mock.calls[0]
    expect(opts.headers?.Authorization ?? opts.headers?.authorization).toMatch(/test-token/)
  })
})

describe('pullVitals', () => {
  it('maps server response to ZeppVitals', async () => {
    const deps = makeDeps(VITALS_RESPONSE)
    const vitals = await pullVitals('2026-08-22', deps)
    expect(vitals?.restingHr).toBe(58)
    expect(vitals?.spo2).toBe(97)
    expect(vitals?.hrv).toBe(42)
  })

  it('returns null on 404', async () => {
    const deps = makeDeps({}, 404)
    expect(await pullVitals('2026-08-22', deps)).toBeNull()
  })
})

describe('pullWorkouts', () => {
  it('maps server response to ZeppWorkout array', async () => {
    const deps = makeDeps(WORKOUTS_RESPONSE)
    const workouts = await pullWorkouts('2026-08-22', deps)
    expect(workouts).toHaveLength(1)
    expect(workouts[0].type).toBe('outdoor_running')
    expect(workouts[0].distanceM).toBe(5200)
    expect(workouts[0].durationSec).toBe(3300)
  })

  it('returns empty array on 404', async () => {
    const deps = makeDeps({}, 404)
    expect(await pullWorkouts('2026-08-22', deps)).toEqual([])
  })
})
