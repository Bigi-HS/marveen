import { describe, it, expect } from 'vitest'
import { HC_TRANSFORM_NODE_JS } from '../web/zepp/hc-transform-node.js'

// F1 (card 75337cdc): the n8n "Transform to Canonical Schema" code node must file every
// record under its OWN local (Budapest) day and emit one canonical snapshot per day,
// instead of dumping a 48h rolling window onto localDate(syncedAt) (the midnight-dead-zone
// mis-filing that put yesterday's sleep/activity into today's file).
//
// We run the EXACT node body that ships to n8n (HC_TRANSFORM_NODE_JS, the single source of
// truth) via `new Function`, so this validates the deployed artifact (DA U1 "post-fix
// verify"), not a hand-kept copy that could drift.
//
// The fixtures below are SYNTHETIC (fake health values) but mirror the real Health Connect
// Webhook payload SHAPE (per-record start_time/end_time, per-Budapest-day step windows,
// day-crossing records, metadata) confirmed against the real Boss golden sample locally.
// Real personal health data is never committed.

type Snapshot = {
  date: string
  synced_at: string
  vitals?: Record<string, number>
  sleep?: { total_min: number; start?: string; end?: string; stages: Record<string, number> }
  workouts?: Array<{ type: string; start?: string; duration_min?: number; distance_m?: number }>
  activity?: { steps?: number; active_kcal?: number; distance_m?: number }
}

function runTransform(body: unknown): Array<{ json: Snapshot }> {
  const fn = new Function('$input', HC_TRANSFORM_NODE_JS) as (
    $input: { first: () => { json: unknown } },
  ) => Array<{ json: Snapshot }>
  return fn({ first: () => ({ json: body }) })
}

function byDay(items: Array<{ json: Snapshot }>): Record<string, Snapshot> {
  return Object.fromEntries(items.map((i) => [i.json.date, i.json]))
}

// A synthetic 48h push whose shape matches the real producer: most data on 08-22, a
// day-crossing step window that belongs to 08-23, and a workout/active_cal from 08-21T22:xxZ
// that resolves (in CEST) to 08-22. Values are deliberately fake.
const SYNTH_PUSH = {
  timestamp: '2026-08-23T11:34:28.190916Z',
  app_version: 'test',
  steps: [{ count: 1234, start_time: '2026-08-22T22:00:00Z', end_time: '2026-08-23T11:34:28Z' }],
  sleep: [
    {
      session_end_time: '2026-08-22T09:54:00Z',
      duration_seconds: 24000,
      stages: [
        { stage: '5', start_time: '2026-08-22T01:46:00Z', end_time: '2026-08-22T03:00:00Z', duration_seconds: 4440 },
        { stage: '4', start_time: '2026-08-22T03:00:00Z', end_time: '2026-08-22T08:00:00Z', duration_seconds: 18000 },
        { stage: '6', start_time: '2026-08-22T08:00:00Z', end_time: '2026-08-22T09:30:00Z', duration_seconds: 5400 },
        { stage: '1', start_time: '2026-08-22T09:30:00Z', end_time: '2026-08-22T09:54:00Z', duration_seconds: 1440 },
      ],
    },
  ],
  heart_rate: [{ time: '2026-08-22T17:00:00Z', avg: 90, min: 70, max: 110, metadata: { data_origin: 'com.huami.watch.hmwatchmanager' } }],
  heart_rate_variability: [{ time: '2026-08-22T13:45:00Z', avg: 40 }],
  distance: [{ meters: 500, start_time: '2026-08-22T16:30:00Z', end_time: '2026-08-22T16:45:00Z' }],
  active_calories: [{ calories: 200, start_time: '2026-08-21T22:30:00Z', end_time: '2026-08-21T22:45:00Z' }],
  oxygen_saturation: [{ time: '2026-08-22T16:00:00Z', avg: 97 }],
  respiratory_rate: [{ time: '2026-08-22T09:45:00Z', avg: 15 }],
  resting_heart_rate: [{ bpm: 55, time: '2026-08-22T09:51:00Z' }],
  exercise: [{ type: '0', start_time: '2026-08-21T22:40:30Z', end_time: '2026-08-21T22:54:45Z', duration_seconds: 855, distance_meters: 460 }],
}

describe('n8n transform: own-day filing (F1)', () => {
  it('splits a 48h push into one snapshot per own-day', () => {
    const days = runTransform(SYNTH_PUSH).map((i) => i.json.date).sort()
    expect(days).toEqual(['2026-08-22', '2026-08-23'])
  })

  it('files sleep under its WAKE day (08-22), never the push day (08-23)', () => {
    const d = byDay(runTransform(SYNTH_PUSH))
    expect(d['2026-08-22'].sleep?.end).toBe('2026-08-22T09:54:00Z')
    expect(d['2026-08-23'].sleep).toBeUndefined()
  })

  it('keeps 08-22 vitals/distance/active_cal/workout on 08-22, steps on 08-23', () => {
    const d = byDay(runTransform(SYNTH_PUSH))
    expect(d['2026-08-22'].vitals?.resting_hr_bpm).toBe(55)
    expect(d['2026-08-22'].activity?.distance_m).toBe(500)
    expect(d['2026-08-22'].activity?.active_kcal).toBe(200)
    expect(d['2026-08-22'].workouts).toHaveLength(1)
    // steps' window starts 08-22T22:00Z = 08-23 00:00 CEST -> steps belong to 08-23.
    expect(d['2026-08-22'].activity?.steps).toBeUndefined()
    expect(d['2026-08-23'].activity?.steps).toBe(1234)
  })

  it('does NOT cross-sum steps from two per-day windows (the live 15850 bug)', () => {
    // The 08-26 file summed {15790 Aug25 full-day} + {60 Aug26 partial} = 15850.
    const out = runTransform({
      timestamp: '2026-08-26T05:26:00Z',
      steps: [
        { count: 15790, start_time: '2026-08-24T22:00:00Z', end_time: '2026-08-25T22:00:00Z' },
        { count: 60, start_time: '2026-08-25T22:00:00Z', end_time: '2026-08-26T05:26:00Z' },
      ],
    })
    const d = byDay(out)
    expect(d['2026-08-25'].activity?.steps).toBe(15790)
    expect(d['2026-08-26'].activity?.steps).toBe(60)
    expect(out.some((i) => i.json.activity?.steps === 15850)).toBe(false)
  })

  it('emits a distinct snapshot for each of a 3-day window', () => {
    const out = runTransform({
      timestamp: '2026-08-23T11:00:00Z',
      active_calories: [{ calories: 96, start_time: '2026-08-21T10:00:00Z' }],
      distance: [{ meters: 178, start_time: '2026-08-22T16:30:00Z' }],
      steps: [{ count: 154, start_time: '2026-08-22T22:00:00Z' }],
    })
    const d = byDay(out)
    expect(out).toHaveLength(3)
    expect(d['2026-08-21'].activity?.active_kcal).toBe(96)
    expect(d['2026-08-22'].activity?.distance_m).toBe(178)
    expect(d['2026-08-23'].activity?.steps).toBe(154)
  })

  it('files an undatable record under the push day instead of dropping it (no-loss)', () => {
    const out = runTransform({ timestamp: '2026-08-23T11:00:00Z', steps: [{ count: 500 }] })
    expect(out).toHaveLength(1)
    expect(out[0].json.date).toBe('2026-08-23')
    expect(out[0].json.activity?.steps).toBe(500)
  })

  it('emits one snapshot for a same-day push and none for an empty push', () => {
    const same = runTransform({
      timestamp: '2026-08-23T20:00:00Z',
      steps: [{ count: 8000, start_time: '2026-08-22T22:00:00Z' }],
      distance: [{ meters: 6000, start_time: '2026-08-23T09:00:00Z' }],
    })
    expect(same).toHaveLength(1)
    expect(same[0].json.date).toBe('2026-08-23')
    expect(runTransform({ timestamp: '2026-08-23T20:00:00Z' })).toHaveLength(0)
  })

  it('every emitted snapshot carries a valid YYYY-MM-DD own-day as its date', () => {
    for (const item of runTransform(SYNTH_PUSH)) {
      expect(item.json.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})
