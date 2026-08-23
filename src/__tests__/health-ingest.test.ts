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

    it('returns 401 for a wrong token of the SAME length (constant-time compare)', async () => {
      // VALID_TOKEN is 15 chars; this wrong token is also 15 chars, so the length
      // guard passes and the constant-time byte comparison must reject it.
      const deps = makeDeps()
      const sameLenWrong = 'test-secret-XYZ'
      expect(sameLenWrong.length).toBe(VALID_TOKEN.length)
      const { status } = await handle(deps, { token: sameLenWrong, body: { date: '2026-08-22' } })
      expect(status).toBe(401)
    })
  })

  describe('body size (DoS guard)', () => {
    it('rejects an oversized (>64KB) body with 413 and does not write a snapshot', async () => {
      const deps = makeDeps()
      const big = 'x'.repeat(70 * 1024) // pushes the JSON body past the 64KB cap
      const { status, snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-22', filler: big },
      })
      expect(status).toBe(413)
      expect(snap).toBeNull()
      expect(deps.writeSnapshot).not.toHaveBeenCalled()
    })

    it('accepts a normal-sized HC payload', async () => {
      const deps = makeDeps()
      const { status } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-22', vitals: { resting_hr_bpm: 52 } },
      })
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
      // A single object carries no naps list.
      expect(snap?.sleep?.naps).toBeUndefined()
    })

    // Multi-session days: HC records one main night plus daytime naps. The transform
    // now forwards ALL sessions as an array; the main night is the longest session and
    // the rest surface as naps[] (Boss asked for nap visibility). Previously only
    // sleep[0] survived, so naps vanished from the daily aggregate.
    it('maps a sleep session ARRAY: main = longest, rest -> naps[]', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: {
          date: '2026-08-13',
          sleep: [
            // main night (484 min)
            { start: '2026-08-12T23:10:00Z', end: '2026-08-13T07:14:00Z', total_min: 484,
              stages: { deep_min: 80, light_min: 300, rem_min: 90, awake_min: 14 } },
            // evening nap (80 min)
            { start: '2026-08-13T17:26:00Z', end: '2026-08-13T18:46:00Z', total_min: 80,
              stages: { deep_min: 5, light_min: 70, rem_min: 5, awake_min: 0 } },
            // short afternoon nap (23 min)
            { start: '2026-08-13T14:55:00Z', end: '2026-08-13T15:18:00Z', total_min: 23 },
          ],
        },
      })
      expect(snap?.sleep?.durationMin).toBe(484)
      expect(snap?.sleep?.startAt).toBe('2026-08-12T23:10:00Z')
      expect(snap?.sleep?.stages?.deep).toBe(80)
      expect(snap?.sleep?.naps).toHaveLength(2)
      // naps ordered by start time (afternoon 14:55 before evening 17:26)
      expect(snap?.sleep?.naps?.[0].durationMin).toBe(23)
      expect(snap?.sleep?.naps?.[0].startAt).toBe('2026-08-13T14:55:00Z')
      expect(snap?.sleep?.naps?.[1].durationMin).toBe(80)
      expect(snap?.sleep?.naps?.[1].stages?.light).toBe(70)
      // a nap does not nest its own naps
      expect(snap?.sleep?.naps?.[1].naps).toBeUndefined()
    })

    it('picks the longest session as main even when it is not first in the array', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: {
          date: '2026-08-13',
          sleep: [
            { start: '2026-08-13T13:00:00Z', end: '2026-08-13T13:40:00Z', total_min: 40 },
            { start: '2026-08-12T23:00:00Z', end: '2026-08-13T06:30:00Z', total_min: 450 },
          ],
        },
      })
      expect(snap?.sleep?.durationMin).toBe(450)
      expect(snap?.sleep?.naps).toHaveLength(1)
      expect(snap?.sleep?.naps?.[0].durationMin).toBe(40)
    })

    it('a single-element session array yields a main with no naps[]', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: {
          date: '2026-08-13',
          sleep: [
            { start: '2026-08-12T23:00:00Z', end: '2026-08-13T06:30:00Z', total_min: 450 },
          ],
        },
      })
      expect(snap?.sleep?.durationMin).toBe(450)
      expect(snap?.sleep?.naps).toBeUndefined()
    })

    it('an empty sleep array yields no sleep block', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-13', sleep: [] },
      })
      expect(snap?.sleep).toBeUndefined()
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

    it('resolves a numeric HC exercise-type code to a name and preserves the raw code', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: {
          date: '2026-08-22',
          workouts: [{ type: '0', start: '2026-08-21T22:40:30Z', duration_min: 14, distance_m: 460 }],
        },
      })
      const w = snap?.workouts?.[0]
      expect(w?.type).toBe('other_workout')
      expect(w?.typeCode).toBe('0')
    })

    it('maps a known HC code (56 -> running)', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-22', workouts: [{ type: '56', start: '2026-08-22T06:00:00Z' }] },
      })
      const w = snap?.workouts?.[0]
      expect(w?.type).toBe('running')
      expect(w?.typeCode).toBe('56')
    })

    it('preserves an unmapped numeric code as typeCode with type unknown (no data loss)', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-22', workouts: [{ type: '9999', start: '2026-08-22T06:00:00Z' }] },
      })
      const w = snap?.workouts?.[0]
      expect(w?.type).toBe('unknown')
      expect(w?.typeCode).toBe('9999')
    })

    it('passes a descriptive name through unchanged without a typeCode', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-22', workouts: [{ type: 'outdoor_running', start: '2026-08-22T06:00:00Z' }] },
      })
      const w = snap?.workouts?.[0]
      expect(w?.type).toBe('outdoor_running')
      expect(w?.typeCode).toBeUndefined()
    })

    it('keeps a workout on its own local day (start 22:40Z -> Budapest next-day 00:40)', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        // 2026-08-21T22:40:30Z is 2026-08-22T00:40 Budapest (CEST +2) -> own day 08-22
        body: { date: '2026-08-22', workouts: [{ type: '0', start: '2026-08-21T22:40:30Z', duration_min: 14 }] },
      })
      expect(snap?.workouts).toHaveLength(1)
      expect(snap?.workouts?.[0]?.startAt).toBe('2026-08-21T22:40:30Z')
    })

    it('drops the same workout from a later day snapshot (48h-window dedup)', async () => {
      const deps = makeDeps()
      // The same session (own day 08-22) recurs in the 08-23 push's 48h window; it must not
      // be filed again under 08-23, else downstream TRIMP double-counts it.
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-23', workouts: [{ type: '0', start: '2026-08-21T22:40:30Z', duration_min: 14 }] },
      })
      expect(snap?.workouts).toBeUndefined()
    })

    it('keeps an undatable workout (missing start) on the current snapshot, no silent loss', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-23', workouts: [{ type: '70', duration_min: 40 }] },
      })
      expect(snap?.workouts).toHaveLength(1)
      expect(snap?.workouts?.[0]?.type).toBe('strength_training')
    })

    // Zepp fragments one continuous activity into several short same-type records with
    // small gaps (measured on the real backfill: type-79 walks split into ~10-16 min
    // pieces with 2-9 min gaps). Merge consecutive same-type records whose gap is under
    // the threshold into one session so downstream load models see one activity, not N.
    it('merges consecutive same-type workouts with a sub-threshold gap into one session', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: {
          date: '2026-08-22',
          workouts: [
            // walk piece 1: 06:00 +30min -> ends 06:30
            { type: '79', start: '2026-08-22T06:00:00Z', duration_min: 30, avg_hr_bpm: 120, distance_m: 3000, kcal: 200 },
            // walk piece 2: starts 06:33 (3 min gap) +20min
            { type: '79', start: '2026-08-22T06:33:00Z', duration_min: 20, avg_hr_bpm: 150, distance_m: 2000, kcal: 150 },
          ],
        },
      })
      expect(snap?.workouts).toHaveLength(1)
      const w = snap?.workouts?.[0]
      expect(w?.type).toBe('walking')
      expect(w?.typeCode).toBe('79')
      expect(w?.startAt).toBe('2026-08-22T06:00:00Z')
      // active duration = sum of the fragments (the gap is rest, not counted)
      expect(w?.durationSec).toBe((30 + 20) * 60)
      expect(w?.distanceM).toBe(5000)
      expect(w?.calories).toBe(350)
      // avgHr duration-weighted: (30*120 + 20*150) / 50 = 132
      expect(w?.avgHr).toBe(132)
    })

    it('does NOT merge same-type workouts separated by an over-threshold gap', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: {
          date: '2026-08-22',
          workouts: [
            { type: '79', start: '2026-08-22T06:00:00Z', duration_min: 15 }, // ends 06:15
            { type: '79', start: '2026-08-22T09:00:00Z', duration_min: 15 }, // gap ~2h45
          ],
        },
      })
      expect(snap?.workouts).toHaveLength(2)
    })

    it('does NOT merge adjacent workouts of different type even with a tiny gap', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: {
          date: '2026-08-22',
          workouts: [
            { type: '79', start: '2026-08-22T06:00:00Z', duration_min: 15 }, // walking, ends 06:15
            { type: '73', start: '2026-08-22T06:16:00Z', duration_min: 15 }, // swimming, 1 min later
          ],
        },
      })
      expect(snap?.workouts).toHaveLength(2)
      expect(snap?.workouts?.map((w) => w.type)).toEqual(['walking', 'swimming_open_water'])
    })

    it('merges a run of three consecutive same-type fragments into one session', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: {
          date: '2026-08-22',
          workouts: [
            { type: '79', start: '2026-08-22T06:00:00Z', duration_min: 10 }, // ends 06:10
            { type: '79', start: '2026-08-22T06:14:00Z', duration_min: 10 }, // gap 4 -> ends 06:24
            { type: '79', start: '2026-08-22T06:29:00Z', duration_min: 10 }, // gap 5
          ],
        },
      })
      expect(snap?.workouts).toHaveLength(1)
      expect(snap?.workouts?.[0]?.durationSec).toBe(30 * 60)
      expect(snap?.workouts?.[0]?.startAt).toBe('2026-08-22T06:00:00Z')
    })

    it('an interleaved different-type record breaks the merge run', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: {
          date: '2026-08-22',
          workouts: [
            { type: '79', start: '2026-08-22T06:00:00Z', duration_min: 10 }, // ends 06:10
            { type: '73', start: '2026-08-22T06:12:00Z', duration_min: 5 },  // swim breaks the run
            { type: '79', start: '2026-08-22T06:20:00Z', duration_min: 10 }, // separate walk
          ],
        },
      })
      expect(snap?.workouts).toHaveLength(3)
      expect(snap?.workouts?.map((w) => w.type)).toEqual(['walking', 'swimming_open_water', 'walking'])
    })

    // The Zepp exercise record carries no HR (avg_hr_bpm is null in the source), yet the
    // load model needs per-workout HR (Banister TRIMP) rather than the whole-day average.
    // HC heart_rate buckets are ~15 min apart, so a short workout is windowed with a
    // half-bucket (+-7.5 min) tolerance to still capture a nearby sample. avgHr is the
    // mean of the bucket avgs in that window; a source-provided avgHr is never overwritten.
    it('fills per-workout avgHr from heart_rate buckets in the workout window', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: {
          date: '2026-08-22',
          workouts: [{ type: '56', start: '2026-08-22T06:00:00Z', duration_min: 30 }],
          heart_rate: [
            { time: '2026-08-22T06:00:00Z', avg: 100 },
            { time: '2026-08-22T06:15:00Z', avg: 110 },
            { time: '2026-08-22T06:30:00Z', avg: 120 },
            { time: '2026-08-22T09:00:00Z', avg: 70 }, // outside the window, ignored
          ],
        },
      })
      expect(snap?.workouts?.[0]?.avgHr).toBe(110)
    })

    it('uses a +-7.5min tolerance so a short workout still catches a nearby bucket', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: {
          date: '2026-08-22',
          // 10-min workout [06:00, 06:10]; window with tolerance is [05:52:30, 06:17:30]
          workouts: [{ type: '56', start: '2026-08-22T06:00:00Z', duration_min: 10 }],
          heart_rate: [
            { time: '2026-08-22T05:53:00Z', avg: 95 },  // 7 min before start, within tolerance
            { time: '2026-08-22T06:15:00Z', avg: 105 }, // 5 min after end, within tolerance
          ],
        },
      })
      expect(snap?.workouts?.[0]?.avgHr).toBe(100)
    })

    it('does not overwrite a source-provided workout avgHr', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: {
          date: '2026-08-22',
          workouts: [{ type: '56', start: '2026-08-22T06:00:00Z', duration_min: 30, avg_hr_bpm: 140 }],
          heart_rate: [{ time: '2026-08-22T06:15:00Z', avg: 90 }],
        },
      })
      expect(snap?.workouts?.[0]?.avgHr).toBe(140)
    })

    it('leaves avgHr undefined when no bucket falls in the window', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: {
          date: '2026-08-22',
          workouts: [{ type: '56', start: '2026-08-22T06:00:00Z', duration_min: 10 }],
          heart_rate: [{ time: '2026-08-22T09:00:00Z', avg: 90 }],
        },
      })
      expect(snap?.workouts?.[0]?.avgHr).toBeUndefined()
    })

    it('leaves avgHr undefined when the body carries no heart_rate array (legacy transform)', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: {
          date: '2026-08-22',
          workouts: [{ type: '56', start: '2026-08-22T06:00:00Z', duration_min: 30 }],
        },
      })
      expect(snap?.workouts?.[0]?.avgHr).toBeUndefined()
    })

    it('computes per-fragment avgHr before merge so the session avgHr is duration-weighted', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: {
          date: '2026-08-22',
          workouts: [
            { type: '79', start: '2026-08-22T06:00:00Z', duration_min: 30 }, // ends 06:30
            { type: '79', start: '2026-08-22T06:33:00Z', duration_min: 10 }, // gap 3 -> merges
          ],
          heart_rate: [
            { time: '2026-08-22T06:10:00Z', avg: 120 }, // only in fragment 1's window
            { time: '2026-08-22T06:45:00Z', avg: 150 }, // only in fragment 2's window
          ],
        },
      })
      expect(snap?.workouts).toHaveLength(1)
      // fragment HRs 120 (30 min) and 150 (10 min) -> (30*120 + 10*150)/40 = 127.5 -> 128
      expect(snap?.workouts?.[0]?.avgHr).toBe(128)
      expect(snap?.workouts?.[0]?.durationSec).toBe(40 * 60)
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
