import { describe, it, expect } from 'vitest'
import { validateDataDate, hasDataDateViolation } from '../web/zepp/data-date-guard.js'
import type { ZeppDailySnapshot } from '../web/zepp/contract.js'

function snap(over: Partial<ZeppDailySnapshot>): ZeppDailySnapshot {
  return { date: '2026-08-22', pulledAt: '2026-08-23T11:34:00.000Z', status: 'ok', ...over }
}

describe('validateDataDate', () => {
  it('passes when the sleep wake-day matches snapshot.date', () => {
    // 08-22T09:54Z -> 11:54 CEST -> 08-22, matches date.
    const v = validateDataDate(
      snap({ date: '2026-08-22', sleep: { durationMin: 487, startAt: '2026-08-22T01:46:00Z', endAt: '2026-08-22T09:54:00Z' } }),
    )
    expect(hasDataDateViolation(v)).toBe(false)
  })

  it('flags sleep filed on the wrong day (the F1 mis-filing: 08-22 sleep on the 08-23 file)', () => {
    const v = validateDataDate(
      snap({ date: '2026-08-23', sleep: { durationMin: 487, startAt: '2026-08-22T01:46:00Z', endAt: '2026-08-22T09:54:00Z' } }),
    )
    expect(hasDataDateViolation(v)).toBe(true)
    expect(v[0].field).toBe('sleep')
    expect(v[0].expected).toBe('2026-08-23')
    expect(v[0].actual).toBe('2026-08-22')
  })

  it('flags a workout whose start day differs from snapshot.date', () => {
    const v = validateDataDate(
      snap({ date: '2026-08-23', workouts: [{ type: '0', startAt: '2026-08-22T16:30:00Z' }] as ZeppDailySnapshot['workouts'] }),
    )
    expect(hasDataDateViolation(v)).toBe(true)
    expect(v[0].field).toBe('workout[0]')
    expect(v[0].actual).toBe('2026-08-22')
  })

  it('does not flag an activity/steps-only snapshot (no timestamps to check)', () => {
    const v = validateDataDate(snap({ date: '2026-08-23', steps: 154, activity: { distanceM: 6000 } }))
    expect(hasDataDateViolation(v)).toBe(false)
  })

  it('passes when every distance slice starts on snapshot.date (DA U6)', () => {
    // Both slices land on 08-26 Budapest (20:00 and 21:15 CEST), matching date.
    const v = validateDataDate(
      snap({
        date: '2026-08-26',
        activity: {
          distanceM: 900,
          distanceSlices: [
            { startAt: '2026-08-26T18:00:00Z', meters: 456 },
            { startAt: '2026-08-26T19:15:00Z', meters: 444 },
          ],
        },
      }),
    )
    expect(hasDataDateViolation(v)).toBe(false)
  })

  it('flags a distance slice from the previous day misfiled on the next (DA U6 dead-zone)', () => {
    // The 00:00-02:00 CEST dead-zone: an after-midnight sync files the previous
    // local day's slice under the next file. slice startAt 08-25T20:00 CEST
    // (Budapest day 08-25) filed on the 08-26 snapshot -> violation.
    const v = validateDataDate(
      snap({
        date: '2026-08-26',
        activity: {
          distanceM: 456,
          distanceSlices: [{ startAt: '2026-08-25T18:00:00Z', meters: 456 }],
        },
      }),
    )
    expect(hasDataDateViolation(v)).toBe(true)
    expect(v[0].field).toBe('activity.distanceSlices[0]')
    expect(v[0].expected).toBe('2026-08-26')
    expect(v[0].actual).toBe('2026-08-25')
  })

  it('flags only the mis-dated slice when others are correct', () => {
    const v = validateDataDate(
      snap({
        date: '2026-08-26',
        activity: {
          distanceM: 900,
          distanceSlices: [
            { startAt: '2026-08-26T18:00:00Z', meters: 456 },
            { startAt: '2026-08-25T18:00:00Z', meters: 444 },
          ],
        },
      }),
    )
    expect(v).toHaveLength(1)
    expect(v[0].field).toBe('activity.distanceSlices[1]')
    expect(v[0].actual).toBe('2026-08-25')
  })

  it('tolerates an unparseable slice timestamp (no false violation)', () => {
    const v = validateDataDate(
      snap({
        date: '2026-08-26',
        activity: { distanceM: 456, distanceSlices: [{ startAt: 'not-a-date', meters: 456 }] },
      }),
    )
    expect(hasDataDateViolation(v)).toBe(false)
  })

  it('ignores sourceSyncedAt entirely (keying off it is the original F1 bug)', () => {
    // sourceSyncedAt on a different day must NOT raise a violation.
    const v = validateDataDate(
      snap({ date: '2026-08-22', sourceSyncedAt: '2026-08-23T00:12:00Z', sleep: { durationMin: 400, startAt: '2026-08-22T00:00:00Z', endAt: '2026-08-22T07:00:00Z' } }),
    )
    expect(hasDataDateViolation(v)).toBe(false)
  })

  it('tolerates an unparseable timestamp (no false violation)', () => {
    const v = validateDataDate(
      snap({ date: '2026-08-22', sleep: { durationMin: 400, startAt: 'not-a-date', endAt: 'not-a-date' } }),
    )
    expect(hasDataDateViolation(v)).toBe(false)
  })
})
