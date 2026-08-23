import { describe, it, expect } from 'vitest'
import { sliceByDay, localDateBudapest } from '../../scripts/zepp-backfill-slice.mjs'

// Shapes mirror the real Zepp/Huami Health Connect blob (verified against the Boss gold
// sample): sleep -> session_end_time; vitals buckets & resting_hr -> time; steps /
// calories / distance / exercise -> start_time.
function buildBlob() {
  return {
    timestamp: '2026-08-23T09:56:00Z',
    app_version: '1.2.3',
    sleep: [
      // ends 08-22 (Budapest): 04:30Z +2 = 06:30 local -> 08-22
      { session_end_time: '2026-08-22T04:30:00Z', duration_seconds: 28000, stages: [] },
      // ends 08-23: 05:00Z +2 = 07:00 local -> 08-23
      { session_end_time: '2026-08-23T05:00:00Z', duration_seconds: 30000, stages: [] },
    ],
    heart_rate: [
      { time: '2026-08-22T10:00:00Z', avg: 80, min: 70, max: 95 },
      { time: '2026-08-23T11:00:00Z', avg: 82, min: 72, max: 99 },
    ],
    resting_heart_rate: [
      { bpm: 60, time: '2026-08-22T06:00:00Z' },
      { bpm: 59, time: '2026-08-23T06:00:00Z' },
    ],
    steps: [
      { count: 500, start_time: '2026-08-22T08:00:00Z', end_time: '2026-08-22T09:00:00Z' },
      { count: 700, start_time: '2026-08-23T08:00:00Z', end_time: '2026-08-23T09:00:00Z' },
    ],
    exercise: [
      // start 08-21T22:40Z +2 = 08-22T00:40 local -> own day 08-22 (matches #517)
      { type: '0', start_time: '2026-08-21T22:40:30Z', end_time: '2026-08-21T22:54:45Z', duration_seconds: 855 },
    ],
  }
}

describe('sliceByDay', () => {
  it('splits a multi-day blob into one sub-payload per calendar day', () => {
    const { days } = sliceByDay(buildBlob())
    expect(days.map((d) => d.date)).toEqual(['2026-08-22', '2026-08-23'])
  })

  it('dates a sleep session by its end time (crossing midnight into the end day)', () => {
    const { days } = sliceByDay(buildBlob())
    const d22 = days.find((d) => d.date === '2026-08-22').payload
    const d23 = days.find((d) => d.date === '2026-08-23').payload
    expect(d22.sleep).toHaveLength(1)
    expect(d22.sleep[0].session_end_time).toBe('2026-08-22T04:30:00Z')
    expect(d23.sleep).toHaveLength(1)
    expect(d23.sleep[0].session_end_time).toBe('2026-08-23T05:00:00Z')
  })

  it('files an exercise on its own local start day (22:40Z -> next-day Budapest)', () => {
    const { days } = sliceByDay(buildBlob())
    const d22 = days.find((d) => d.date === '2026-08-22').payload
    expect(d22.exercise).toHaveLength(1)
    expect(d22.exercise[0].start_time).toBe('2026-08-21T22:40:30Z')
    // and NOT on 08-23
    const d23 = days.find((d) => d.date === '2026-08-23').payload
    expect(d23.exercise).toBeUndefined()
  })

  it('sets each day timestamp to D-noon UTC so the transform dates no-sleep days to D too', () => {
    const { days } = sliceByDay(buildBlob())
    for (const { date, payload } of days) {
      expect(payload.timestamp).toBe(`${date}T12:00:00Z`)
      // noon UTC resolves to the same local calendar day (DST-safe, far from midnight)
      expect(localDateBudapest(payload.timestamp)).toBe(date)
    }
  })

  it('carries passthrough metadata (app_version) into every day', () => {
    const { days } = sliceByDay(buildBlob())
    for (const { payload } of days) expect(payload.app_version).toBe('1.2.3')
  })

  it('routes each vitals bucket / steps entry to its own day', () => {
    const { days } = sliceByDay(buildBlob())
    const d22 = days.find((d) => d.date === '2026-08-22').payload
    const d23 = days.find((d) => d.date === '2026-08-23').payload
    expect(d22.heart_rate).toHaveLength(1)
    expect(d22.steps[0].count).toBe(500)
    expect(d23.steps[0].count).toBe(700)
    expect(d22.resting_heart_rate[0].bpm).toBe(60)
  })

  it('a single-day blob yields exactly one day (backfill of a 1-day window)', () => {
    const blob = { timestamp: '2026-08-22T09:00:00Z', sleep: [{ session_end_time: '2026-08-22T04:30:00Z', stages: [] }] }
    const { days } = sliceByDay(blob)
    expect(days).toHaveLength(1)
    expect(days[0].date).toBe('2026-08-22')
  })

  it('surfaces undated entries instead of silently dropping them', () => {
    const blob = {
      timestamp: '2026-08-22T09:00:00Z',
      heart_rate: [{ avg: 80 }, { time: '2026-08-22T10:00:00Z', avg: 81 }],
    }
    const { days, undated } = sliceByDay(blob)
    expect(days).toHaveLength(1)
    expect(days[0].payload.heart_rate).toHaveLength(1)
    expect(undated.heart_rate).toHaveLength(1)
  })

  it('ignores an invalid timestamp (falls through to undated, no crash)', () => {
    const blob = { steps: [{ count: 10, start_time: 'not-a-date' }] }
    const { days, undated } = sliceByDay(blob)
    expect(days).toHaveLength(0)
    expect(undated.steps).toHaveLength(1)
  })

  it('is lossless and non-duplicating: per-day counts + undated sum back to source', () => {
    const blob = buildBlob()
    const { days, undated } = sliceByDay(blob)
    const sourceCounts = {}
    for (const [k, v] of Object.entries(blob)) if (Array.isArray(v)) sourceCounts[k] = v.length
    const seen = {}
    for (const { payload } of days) {
      for (const [k, v] of Object.entries(payload)) {
        if (Array.isArray(v)) seen[k] = (seen[k] ?? 0) + v.length
      }
    }
    for (const [k, u] of Object.entries(undated)) seen[k] = (seen[k] ?? 0) + u.length
    expect(seen).toEqual(sourceCounts)
  })

  it('buckets an unforeseen array key generically (e.g. weight, keyed by time)', () => {
    const blob = { weight: [{ kilograms: 80, time: '2026-08-22T07:00:00Z' }] }
    const { days } = sliceByDay(blob)
    expect(days).toHaveLength(1)
    expect(days[0].date).toBe('2026-08-22')
    expect(days[0].payload.weight[0].kilograms).toBe(80)
  })
})
