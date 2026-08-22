import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ZeppDailySnapshot } from '../web/zepp/contract.js'
import { makeHealthIngestHandler, type HealthIngestDeps } from '../web/routes/health-ingest.js'

function makeReq(opts: {
  method?: string
  token?: string
  body?: unknown
}): IncomingMessage {
  const { method = 'POST', token, body } = opts
  const bodyStr = body !== undefined ? JSON.stringify(body) : ''
  const readable = Readable.from([Buffer.from(bodyStr)]) as unknown as IncomingMessage
  readable.method = method
  readable.headers = {
    'content-type': 'application/json',
    ...(token !== undefined ? { 'x-ingest-token': token } : {}),
  }
  return readable
}

function makeRes(): { res: ServerResponse; written: () => { status: number; body: string } } {
  let status = 200
  let body = ''
  const res = {
    writeHead: vi.fn((s: number) => { status = s }),
    end: vi.fn((b: string) => { body = b }),
    setHeader: vi.fn(),
    getHeader: vi.fn(),
  } as unknown as ServerResponse
  return { res, written: () => ({ status, body }) }
}

const VALID_TOKEN = 'test-secret-abc'

function makeDeps(over: Partial<HealthIngestDeps> = {}): HealthIngestDeps {
  return {
    readIngestToken: () => VALID_TOKEN,
    writeSnapshot: vi.fn(),
    nowIso: () => '2026-08-22T18:00:00.000Z',
    ...over,
  }
}

async function handle(
  deps: HealthIngestDeps,
  reqOpts: Parameters<typeof makeReq>[0],
): Promise<{ status: number; body: string; snap: ZeppDailySnapshot | null }> {
  const handler = makeHealthIngestHandler(deps)
  const req = makeReq(reqOpts)
  const { res, written } = makeRes()
  let capturedSnap: ZeppDailySnapshot | null = null
  const origImpl = (deps.writeSnapshot as ReturnType<typeof vi.fn>).getMockImplementation()
  ;(deps.writeSnapshot as ReturnType<typeof vi.fn>).mockImplementation((s: ZeppDailySnapshot) => {
    capturedSnap = s
    origImpl?.(s)
  })
  await handler(req, res)
  return { ...written(), snap: capturedSnap }
}

describe('POST /api/health/ingest', () => {
  describe('auth', () => {
    it('returns 401 when X-Ingest-Token header is missing', async () => {
      const deps = makeDeps()
      const { status } = await handle(deps, { body: { date: '2026-08-22' } })
      expect(status).toBe(401)
    })

    it('returns 401 when X-Ingest-Token is wrong', async () => {
      const deps = makeDeps()
      const { status } = await handle(deps, { token: 'wrong', body: { date: '2026-08-22' } })
      expect(status).toBe(401)
    })

    it('proceeds when X-Ingest-Token is correct', async () => {
      const deps = makeDeps()
      const { status } = await handle(deps, { token: VALID_TOKEN, body: { date: '2026-08-22' } })
      expect(status).toBe(200)
    })
  })

  describe('validation', () => {
    it('returns 400 when date is missing', async () => {
      const deps = makeDeps()
      const { status } = await handle(deps, { token: VALID_TOKEN, body: {} })
      expect(status).toBe(400)
    })

    it('returns 400 when date is malformed', async () => {
      const deps = makeDeps()
      const { status } = await handle(deps, { token: VALID_TOKEN, body: { date: '22-08-2026' } })
      expect(status).toBe(400)
    })

    it('ignores non-POST methods (returns without writing)', async () => {
      const deps = makeDeps()
      const handler = makeHealthIngestHandler(deps)
      const req = makeReq({ method: 'GET', token: VALID_TOKEN })
      const { res, written } = makeRes()
      await handler(req, res)
      expect(written().status).toBe(200)
      expect(deps.writeSnapshot).not.toHaveBeenCalled()
    })
  })

  describe('snapshot status', () => {
    it('status=ok when vitals present', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-22', vitals: { resting_hr_bpm: 58 } },
      })
      expect(snap?.status).toBe('ok')
    })

    it('status=ok when sleep present', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-22', sleep: { total_min: 420, start: '2026-08-21T23:00:00Z', end: '2026-08-22T06:00:00Z' } },
      })
      expect(snap?.status).toBe('ok')
    })

    it('status=no_new_data when only date provided', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-22' },
      })
      expect(snap?.status).toBe('no_new_data')
    })
  })

  describe('silent-guard: snapshot always written', () => {
    it('writes snapshot even for no_new_data push', async () => {
      const deps = makeDeps()
      await handle(deps, { token: VALID_TOKEN, body: { date: '2026-08-22' } })
      expect(deps.writeSnapshot).toHaveBeenCalledTimes(1)
    })

    it('writes snapshot with correct date and pulledAt', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-22', vitals: { resting_hr_bpm: 60 } },
      })
      expect(snap?.date).toBe('2026-08-22')
      expect(snap?.pulledAt).toBe('2026-08-22T18:00:00.000Z')
    })
  })

  describe('payload mapping', () => {
    it('maps HC vitals to ZeppVitals', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: {
          date: '2026-08-22',
          vitals: {
            resting_hr_bpm: 58,
            hrv_rmssd_ms: 42.5,
            spo2_pct: 97,
            respiratory_rate_bpm: 14,
            skin_temp_c: 33.1,
            hr_avg_bpm: 72,
            hr_min_bpm: 52,
            hr_max_bpm: 141,
          },
        },
      })
      expect(snap?.vitals?.restingHr).toBe(58)
      expect(snap?.vitals?.hrv).toBe(42.5)
      expect(snap?.vitals?.spo2).toBe(97)
      expect(snap?.vitals?.breathingRate).toBe(14)
      expect(snap?.vitals?.skinTemp).toBe(33.1)
      expect(snap?.vitals?.hrAvg).toBe(72)
      expect(snap?.vitals?.hrMin).toBe(52)
      expect(snap?.vitals?.hrMax).toBe(141)
    })

    it('maps HC sleep to ZeppSleep', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: {
          date: '2026-08-22',
          sleep: {
            start: '2026-08-21T22:40:00Z',
            end: '2026-08-22T06:15:00Z',
            total_min: 415,
            stages: { deep_min: 78, light_min: 240, rem_min: 85, awake_min: 12 },
          },
        },
      })
      expect(snap?.sleep?.durationMin).toBe(415)
      expect(snap?.sleep?.startAt).toBe('2026-08-21T22:40:00Z')
      expect(snap?.sleep?.endAt).toBe('2026-08-22T06:15:00Z')
      expect(snap?.sleep?.stages?.deep).toBe(78)
      expect(snap?.sleep?.stages?.light).toBe(240)
      expect(snap?.sleep?.stages?.rem).toBe(85)
      expect(snap?.sleep?.stages?.awake).toBe(12)
    })

    it('maps HC activity to snapshot top-level fields', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: {
          date: '2026-08-22',
          activity: { steps: 8421, total_kcal: 2180, active_kcal: 540, distance_m: 6200, floors: 12, vo2max: 44.0 },
        },
      })
      expect(snap?.steps).toBe(8421)
      expect(snap?.caloriesTotal).toBe(2180)
      expect(snap?.activity?.activeKcal).toBe(540)
      expect(snap?.activity?.distanceM).toBe(6200)
      expect(snap?.activity?.floors).toBe(12)
      expect(snap?.activity?.vo2max).toBe(44.0)
    })

    it('maps HC workouts to ZeppWorkout[]', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: {
          date: '2026-08-22',
          workouts: [{
            type: 'running',
            start: '2026-08-22T06:30:00Z',
            end: '2026-08-22T07:05:00Z',
            duration_min: 35,
            avg_hr_bpm: 148,
            kcal: 320,
            distance_m: 5000,
          }],
        },
      })
      expect(snap?.workouts).toHaveLength(1)
      const w = snap?.workouts?.[0]
      expect(w?.type).toBe('running')
      expect(w?.startAt).toBe('2026-08-22T06:30:00Z')
      expect(w?.durationSec).toBe(35 * 60)
      expect(w?.avgHr).toBe(148)
      expect(w?.calories).toBe(320)
      expect(w?.distanceM).toBe(5000)
    })
  })

  describe('idempotency', () => {
    it('overwrites same date (last-write-wins)', async () => {
      let written: ZeppDailySnapshot | null = null
      const deps = makeDeps({
        writeSnapshot: vi.fn((s) => { written = s }),
      })
      await handle(deps, { token: VALID_TOKEN, body: { date: '2026-08-22', vitals: { resting_hr_bpm: 58 } } })
      await handle(deps, { token: VALID_TOKEN, body: { date: '2026-08-22', vitals: { resting_hr_bpm: 62 } } })
      expect(deps.writeSnapshot).toHaveBeenCalledTimes(2)
      expect((deps.writeSnapshot as ReturnType<typeof vi.fn>).mock.calls[1][0].vitals?.restingHr).toBe(62)
    })
  })
})
