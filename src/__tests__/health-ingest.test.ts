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
    readSnapshot: () => null,
    writeSnapshot: vi.fn(),
    nowIso: () => '2026-08-22T18:00:00.000Z',
    ...over,
  }
}

// Deps backed by an in-memory store so sequential same-date pushes accumulate, mirroring
// the on-disk daily file. Used by the AC-A8 no-clobber tests where read-modify-write matters.
function makeStatefulDeps(): HealthIngestDeps {
  const store = new Map<string, ZeppDailySnapshot>()
  return {
    readIngestToken: () => VALID_TOKEN,
    readSnapshot: (date: string) => store.get(date) ?? null,
    writeSnapshot: vi.fn((s: ZeppDailySnapshot) => { store.set(s.date, s) }),
    nowIso: () => '2026-08-22T18:00:00.000Z',
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

  // AC-A8 (WELL-018): the handler reads the existing daily snapshot and merges the incoming
  // push field-by-field (null-only), so a partial or empty same-date push never wipes data
  // an earlier push wrote. AC-A5 (full-record overwrite) stays green but is blind to this
  // partial-push clobber. Spec: store/specs/zepp-well-018-health-ingest.md (Path A).
  describe('AC-A8: no-clobber field-merge', () => {
    const SLEEP_BODY = {
      total_min: 420, start: '2026-08-21T23:00:00Z', end: '2026-08-22T06:00:00Z',
    }

    // Test 1: a push carrying sleep writes a snapshot containing sleep.
    it('writes a snapshot containing sleep when sleep is pushed', async () => {
      const deps = makeStatefulDeps()
      const { snap } = await handle(deps, { token: VALID_TOKEN, body: { date: '2026-08-22', sleep: SLEEP_BODY } })
      expect(snap?.sleep?.durationMin).toBe(420)
    })

    // Test 2: an evening workouts-only push must not clobber the morning sleep.
    it('a workouts-only delta push preserves an earlier sleep (both survive)', async () => {
      const deps = makeStatefulDeps()
      await handle(deps, { token: VALID_TOKEN, body: { date: '2026-08-22', sleep: SLEEP_BODY } })
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-22', workouts: [{ type: 'running', start: '2026-08-22T06:30:00Z', duration_min: 35, avg_hr_bpm: 148 }] },
      })
      expect(snap?.sleep?.durationMin).toBe(420) // morning sleep preserved
      expect(snap?.workouts).toHaveLength(1) // evening workout added
    })

    // Test 3: an empty (no_new_data) push must not overwrite an ok record, in data OR status.
    it('an empty no_new_data push does not clobber an ok record (data and status survive)', async () => {
      const deps = makeStatefulDeps()
      await handle(deps, { token: VALID_TOKEN, body: { date: '2026-08-22', vitals: { resting_hr_bpm: 52, hrv_rmssd_ms: 60 } } })
      const { snap } = await handle(deps, { token: VALID_TOKEN, body: { date: '2026-08-22' } })
      expect(snap?.vitals?.restingHr).toBe(52)
      expect(snap?.vitals?.hrv).toBe(60)
      expect(snap?.status).toBe('ok') // NOT downgraded to no_new_data
    })

    // Test 4: a fewer-fields ok push preserves the fields it omits (not just status).
    it('a sleep-only ok push preserves earlier workouts', async () => {
      const deps = makeStatefulDeps()
      await handle(deps, {
        token: VALID_TOKEN,
        body: {
          date: '2026-08-22',
          sleep: { total_min: 400, start: '2026-08-21T23:00:00Z', end: '2026-08-22T05:40:00Z' },
          workouts: [{ type: 'running', start: '2026-08-22T06:30:00Z', duration_min: 30 }],
        },
      })
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-22', sleep: { total_min: 415, start: '2026-08-21T22:50:00Z', end: '2026-08-22T05:45:00Z' } },
      })
      expect(snap?.sleep?.durationMin).toBe(415) // sleep updated
      expect(snap?.workouts).toHaveLength(1) // workouts preserved
    })

    // Test 5: a workouts push REPLACES the stored array (no append -> no TRIMP double count).
    it('a workouts push replaces the stored workouts rather than appending', async () => {
      const deps = makeStatefulDeps()
      await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-22', workouts: [{ type: 'running', start: '2026-08-22T06:30:00Z', duration_min: 30 }] },
      })
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-22', workouts: [{ type: 'walking', start: '2026-08-22T18:00:00Z', duration_min: 20 }] },
      })
      expect(snap?.workouts).toHaveLength(1) // replaced, not [running, walking]
      expect(snap?.workouts?.[0]?.type).toBe('walking')
    })

    // DA refinement: an explicit null field is treated as absent (no field-delete signal).
    it('an explicit null field does not clobber (explicit null == absent)', async () => {
      const deps = makeStatefulDeps()
      await handle(deps, { token: VALID_TOKEN, body: { date: '2026-08-22', sleep: SLEEP_BODY } })
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-22', sleep: null, vitals: { resting_hr_bpm: 50 } },
      })
      expect(snap?.sleep?.durationMin).toBe(420) // explicit sleep:null did not wipe
      expect(snap?.vitals?.restingHr).toBe(50)
    })
  })

  // card 75337cdc distance=B: the phone pushes a 48h rolling window, so each push carries
  // only the distance slices still inside it. The server must accumulate them into an
  // append-only per-day ledger (deduped by startAt) so distanceM is the true daily sum and
  // a later narrow-window push cannot clobber it down (the live 456m-for-a-full-day bug).
  describe('distance slice-ledger (no clobber-down)', () => {
    it('accumulates disjoint distance slices across pushes into the daily total', async () => {
      const deps = makeStatefulDeps()
      await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-25', activity: { distance_slices: [{ start: '2026-08-25T21:15:00Z', end: '2026-08-25T21:30:00Z', meters: 105 }], distance_m: 105 } },
      })
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-25', activity: { distance_slices: [{ start: '2026-08-25T22:00:00Z', end: '2026-08-25T22:15:00Z', meters: 435 }], distance_m: 435 } },
      })
      expect(snap?.activity?.distanceSlices).toHaveLength(2)
      expect(snap?.activity?.distanceM).toBe(540)
    })

    it('does NOT clobber the day total when a later push carries a narrower window', async () => {
      const deps = makeStatefulDeps()
      // First push: full window (three slices, 947m).
      await handle(deps, {
        token: VALID_TOKEN,
        body: {
          date: '2026-08-25',
          activity: {
            distance_slices: [
              { start: '2026-08-25T21:15:00Z', meters: 105 },
              { start: '2026-08-25T22:00:00Z', meters: 435 },
              { start: '2026-08-26T04:30:00Z', meters: 407 },
            ],
            distance_m: 947,
          },
        },
      })
      // Second push: window slid, only the newest slice remains (the live clobber trigger).
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-25', activity: { distance_slices: [{ start: '2026-08-26T04:30:00Z', meters: 407 }], distance_m: 407 } },
      })
      expect(snap?.activity?.distanceM).toBe(947) // stays full, not clobbered to 407
      expect(snap?.activity?.distanceSlices).toHaveLength(3)
    })

    it('dedups a repeated slice by startAt (no double count across pushes)', async () => {
      const deps = makeStatefulDeps()
      const slice = { start: '2026-08-25T21:15:00Z', meters: 105 }
      await handle(deps, { token: VALID_TOKEN, body: { date: '2026-08-25', activity: { distance_slices: [slice], distance_m: 105 } } })
      const { snap } = await handle(deps, { token: VALID_TOKEN, body: { date: '2026-08-25', activity: { distance_slices: [slice], distance_m: 105 } } })
      expect(snap?.activity?.distanceSlices).toHaveLength(1)
      expect(snap?.activity?.distanceM).toBe(105) // not 210
    })

    // The ledger's no-clobber-down guarantee only holds if every slice contributes a
    // non-negative distance. num() accepts a negative finite value, so without a guard a
    // negative meters slice would DRAG the day sum DOWN -- the exact clobber the ledger
    // exists to prevent (chad gate FLAG seat 801). A negative slice is malformed: drop it.
    it('drops a slice with negative meters (never reduces the day total) [seat 801]', async () => {
      const deps = makeStatefulDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: {
          date: '2026-08-25',
          activity: {
            distance_slices: [
              { start: '2026-08-25T21:15:00Z', meters: 105 },
              { start: '2026-08-25T22:00:00Z', meters: -500 },
            ],
            distance_m: 105,
          },
        },
      })
      expect(snap?.activity?.distanceSlices).toHaveLength(1)
      expect(snap?.activity?.distanceM).toBe(105) // not -395
    })

    // The DROP branch (malformed entries silently skipped) had no dedicated coverage before
    // (chad gate INFO). A slice with no startAt (the ledger dedup key) or a non-finite meters
    // is dropped rather than poisoning the sum; the valid sibling in the same push survives.
    it('drops malformed slices (missing startAt / non-finite meters), keeps the valid one', async () => {
      const deps = makeStatefulDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: {
          date: '2026-08-25',
          activity: {
            distance_slices: [
              { meters: 200 }, // no startAt -> dropped
              { start: '2026-08-25T22:00:00Z', meters: 'not-a-number' }, // non-finite -> dropped
              { start: '2026-08-25T21:15:00Z', meters: 105 }, // valid
            ],
            distance_m: 105,
          },
        },
      })
      expect(snap?.activity?.distanceSlices).toHaveLength(1)
      expect(snap?.activity?.distanceSlices?.[0]?.startAt).toBe('2026-08-25T21:15:00Z')
      expect(snap?.activity?.distanceM).toBe(105)
    })
  })

  // WELL-028: when the merged day's measured distance is implausibly short for its steps
  // (the BUG-2 upstream loss), the handler labels distanceSource and stores a step-derived
  // estimate WITHOUT overwriting the measured distanceM.
  describe('step-distance estimate remediation', () => {
    it('labels and estimates a distance-short day (live 08-25: 456m at 15790 steps)', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-25', activity: { steps: 15790, distance_m: 456 } },
      })
      expect(snap?.activity?.distanceSource).toBe('step_estimated')
      expect(snap?.activity?.estimatedDistanceM).toBe(12032)
      expect(snap?.activity?.distanceM).toBe(456) // measured value untouched
    })

    it('labels a coherent day measured and stores no estimate', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-26', activity: { steps: 13694, distance_m: 12040 } },
      })
      expect(snap?.activity?.distanceSource).toBe('measured')
      expect(snap?.activity?.estimatedDistanceM).toBeUndefined()
    })

    it('drops a stale estimate once a later push carries the real distance', async () => {
      const deps = makeStatefulDeps()
      // First push: only a narrow slice landed -> distance short -> estimate surfaces.
      let { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-25', activity: { steps: 15790, distance_slices: [{ start: '2026-08-25T21:15:00Z', meters: 456 }], distance_m: 456 } },
      })
      expect(snap?.activity?.distanceSource).toBe('step_estimated')
      // Later pushes accumulate the rest of the day into the ledger -> measured catches up.
      ;({ snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-25', activity: { distance_slices: [{ start: '2026-08-25T22:00:00Z', meters: 11600 }], distance_m: 11600 } },
      }))
      expect(snap?.activity?.distanceM).toBe(12056) // 456 + 11600, ledger sum
      expect(snap?.activity?.distanceSource).toBe('measured')
      expect(snap?.activity?.estimatedDistanceM).toBeUndefined()
    })
  })

  // card 75337cdc: numeric plausibility guard, log-only rollout. The handler flags a
  // suspect merged day via onPlausibility but must NOT mutate the stored status.
  describe('plausibility guard (log-only)', () => {
    it('calls onPlausibility for a physically impossible activity push (live 08-25 bug)', async () => {
      const onPlausibility = vi.fn()
      const deps = makeDeps({ onPlausibility })
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-25', activity: { steps: 15790, active_kcal: 5, distance_m: 456 } },
      })
      expect(onPlausibility).toHaveBeenCalledTimes(1)
      const [, violations] = onPlausibility.mock.calls[0]
      expect(violations.some((v: { severity: string }) => v.severity === 'suspect')).toBe(true)
      // log-only: the stored status is untouched, no data change.
      expect(snap?.status).toBe('ok')
    })

    it('catches the DA falsifier #3 absurd push (kcal=3, dist=1, steps=20000)', async () => {
      const onPlausibility = vi.fn()
      const deps = makeDeps({ onPlausibility })
      await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-26', activity: { steps: 20000, active_kcal: 3, distance_m: 1 } },
      })
      expect(onPlausibility).toHaveBeenCalledTimes(1)
    })

    it('does NOT call onPlausibility for a coherent activity push', async () => {
      const onPlausibility = vi.fn()
      const deps = makeDeps({ onPlausibility })
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-25', activity: { steps: 13694, active_kcal: 1011, distance_m: 12040 } },
      })
      expect(onPlausibility).not.toHaveBeenCalled()
      expect(snap?.status).toBe('ok')
    })

    it('judges plausibility on the MERGED day (activity + steps from separate pushes)', async () => {
      const onPlausibility = vi.fn()
      const deps = makeStatefulDeps()
      deps.onPlausibility = onPlausibility
      // First push: steps only (no activity block yet -> no coherence check possible).
      await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-25', activity: { steps: 15790 } },
      })
      expect(onPlausibility).not.toHaveBeenCalled()
      // Second push: the broken distance/kcal arrive -> merged day is now incoherent.
      await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-25', activity: { active_kcal: 5, distance_m: 456 } },
      })
      expect(onPlausibility).toHaveBeenCalledTimes(1)
    })
  })

  // card 44783957 P0 (G3): the cross-field anomaly signal is persisted as a health flag via
  // recordAnomaly on EVERY push -- with the suspect violations when present, and with [] on a
  // clean push so an open flag resolves. This closes the silent-observer gap (log-only).
  describe('anomaly flag emit (G3)', () => {
    it('records the suspect violations on a physically impossible push (live 08-25)', async () => {
      const recordAnomaly = vi.fn()
      const deps = makeDeps({ recordAnomaly })
      await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-25', activity: { steps: 15790, active_kcal: 5, distance_m: 456 } },
      })
      expect(recordAnomaly).toHaveBeenCalledTimes(1)
      const [date, suspect] = recordAnomaly.mock.calls[0]
      expect(date).toBe('2026-08-25')
      expect(suspect.length).toBeGreaterThan(0)
      expect(suspect.every((v: { severity: string }) => v.severity === 'suspect')).toBe(true)
    })

    it('records an empty suspect list on a coherent push (so an open flag can resolve)', async () => {
      const recordAnomaly = vi.fn()
      const deps = makeDeps({ recordAnomaly })
      await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-26', activity: { steps: 10000, active_kcal: 450, distance_m: 7600 } },
      })
      expect(recordAnomaly).toHaveBeenCalledTimes(1)
      const [, suspect] = recordAnomaly.mock.calls[0]
      expect(suspect).toEqual([])
    })

    it('is called on every push, even a no_new_data push (empty suspect)', async () => {
      const recordAnomaly = vi.fn()
      const deps = makeDeps({ recordAnomaly })
      await handle(deps, { token: VALID_TOKEN, body: { date: '2026-08-26' } })
      expect(recordAnomaly).toHaveBeenCalledTimes(1)
      expect(recordAnomaly.mock.calls[0][1]).toEqual([])
    })
  })

  // card 75337cdc Q2: data-date guard, log-only. The handler flags a snapshot whose
  // timestamped fields resolve to a different Budapest day than snapshot.date, but must
  // NOT mutate the stored status.
  describe('data-date guard (log-only)', () => {
    it('does NOT call onDataDate for a wrong-day INCOMING sleep (2f603c1c own-date filter drops it first)', async () => {
      // With the sleep own-date filter (2f603c1c), a wrong-day push is DROPPED before
      // it enters the snapshot, so the data-date guard never fires for incoming mis-filings.
      // (The data-date guard still catches HISTORICAL mis-filings already in the store from
      // before the filter was deployed -- those can't be re-filtered on merge.)
      const onDataDate = vi.fn()
      const deps = makeDeps({ onDataDate })
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        // body.date says 08-23 but sleep wakes on 08-22 -> own-date filter drops the sleep.
        body: { date: '2026-08-23', sleep: { total_min: 420, start: '2026-08-22T01:46:00Z', end: '2026-08-22T09:54:00Z' } },
      })
      // Sleep was dropped by the own-date filter -> no sleep in snapshot, status=no_new_data
      expect(snap?.sleep).toBeUndefined()
      expect(snap?.status).toBe('no_new_data')
      // The data-date guard has nothing to report (no mis-filed sleep in the snapshot)
      expect(onDataDate).not.toHaveBeenCalled()
    })

    it('does NOT call onDataDate when the sleep wake-day matches the file date', async () => {
      const onDataDate = vi.fn()
      const deps = makeDeps({ onDataDate })
      await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-22', sleep: { total_min: 420, start: '2026-08-22T01:46:00Z', end: '2026-08-22T09:54:00Z' } },
      })
      expect(onDataDate).not.toHaveBeenCalled()
    })
  })

  // AC#1 (card e3197a20): physiological input-cap for steps/kcal/distanceM.
  // Values outside the sane range are DROPPED (undefined) at parse time, not just flagged.
  // This prevents an inflated step count from propagating into the monotone-max lock that
  // drives the distance estimate (Chad FN fixture: steps=999999 -> 762km estimate blocked).
  describe('AC#1 input-cap: steps / kcal / distanceM sane range', () => {
    // Steps
    it('[FN] drops steps above the cap (999,999 -> undefined, prevents 762km estimate)', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-22', activity: { steps: 999_999, distance_m: undefined } },
      })
      // steps exceeds cap -> dropped; NO distance estimate from phantom steps
      expect(snap?.steps).toBeUndefined()
      expect(snap?.activity?.estimatedDistanceM).toBeUndefined()
    })

    it('[FP] keeps steps within the cap (20,000 is a legitimate high-activity day)', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-22', activity: { steps: 20_000, distance_m: 15_000 } },
      })
      expect(snap?.steps).toBe(20_000)
    })

    it('[opposing-clean] reference day passes cap unchanged (15,790 steps, 12,040m)', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-22', activity: { steps: 15_790, distance_m: 12_040 } },
      })
      expect(snap?.steps).toBe(15_790)
      expect(snap?.activity?.distanceM).toBe(12_040)
    })

    it('drops negative steps (non-negative invariant)', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-22', activity: { steps: -500 } },
      })
      expect(snap?.steps).toBeUndefined()
    })

    // activeKcal
    it('drops impossibly high activeKcal (above sane cap)', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-22', activity: { active_kcal: 50_000, steps: 10_000, distance_m: 8_000 } },
      })
      expect(snap?.activity?.activeKcal).toBeUndefined()
    })

    it('keeps a plausible activeKcal (600 kcal, normal athletic day)', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-22', activity: { active_kcal: 600, steps: 10_000, distance_m: 8_000 } },
      })
      expect(snap?.activity?.activeKcal).toBe(600)
    })

    // activity.distanceM
    it('drops impossibly high activity distanceM (above sane cap)', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-22', activity: { distance_m: 900_000, steps: 10_000 } },
      })
      expect(snap?.activity?.distanceM).toBeUndefined()
    })

    it('keeps a plausible activity distanceM (12,040m)', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-22', activity: { distance_m: 12_040, steps: 15_790 } },
      })
      expect(snap?.activity?.distanceM).toBe(12_040)
    })
  })

  // 2f603c1c: sleep own-date guard.
  // Mirror of the workout own-day filter (line ~265): only accept a sleep session into
  // this snapshot if the sleep's wake date (endAt localDateBudapest) matches body.date.
  // Edge case: a midnight push (00:20) where body.date = new day but the sleep payload
  // still carries yesterday's session (endAt = yesterday) would mis-file the sleep.
  describe('sleep own-date guard (2f603c1c)', () => {
    // S1: normal case -- sleep ends on the same day as body.date -> filed
    it('S1: files sleep when sleep.endAt local date matches body.date', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        // 2026-08-22T06:00:00Z = 2026-08-22T08:00:00 Budapest (CEST+2) -> day 08-22
        body: { date: '2026-08-22', sleep: { total_min: 420, start: '2026-08-21T23:00:00Z', end: '2026-08-22T06:00:00Z' } },
      })
      expect(snap?.sleep).toBeDefined()
      expect(snap?.sleep?.durationMin).toBe(420)
    })

    // S2: midnight push edge -- body.date = next day but sleep woke on previous day -> NOT filed
    it('S2: does NOT file sleep when sleep.endAt belongs to a different day than body.date', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        // body.date = 08-23, but sleep endAt = 2026-08-22T07:00:00Z (Budapest 09:00 on 08-22)
        body: { date: '2026-08-23', sleep: { total_min: 420, start: '2026-08-21T23:00:00Z', end: '2026-08-22T07:00:00Z' } },
      })
      // Sleep belongs to 08-22, not 08-23 -> not included in the 08-23 snapshot
      expect(snap?.sleep).toBeUndefined()
    })

    // S3: missing or invalid endAt -> keep-on-current (no filtering, same as undatable workout)
    it('S3: keeps sleep when endAt is absent (cannot determine day, file conservatively)', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-22', sleep: { total_min: 420, start: '2026-08-21T23:00:00Z' } },
      })
      // No endAt -> no own-day filtering -> sleep is included
      expect(snap?.sleep).toBeDefined()
    })

    it('S3: keeps sleep when endAt is invalid (non-parseable timestamp)', async () => {
      const deps = makeDeps()
      const { snap } = await handle(deps, {
        token: VALID_TOKEN,
        body: { date: '2026-08-22', sleep: { total_min: 420, start: '2026-08-21T23:00:00Z', end: 'not-a-date' } },
      })
      expect(snap?.sleep).toBeDefined()
    })
  })
})
