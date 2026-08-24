import { describe, it, expect } from 'vitest'
import type { ZeppDailySnapshot } from '../web/zepp/contract.js'
import { mergeDailySnapshot } from '../web/zepp/snapshot-merge.js'

function snap(over: Partial<ZeppDailySnapshot>): ZeppDailySnapshot {
  return { date: '2026-08-22', pulledAt: '2026-08-22T18:00:00.000Z', status: 'ok', ...over }
}

describe('mergeDailySnapshot', () => {
  it('returns the incoming snapshot unchanged when there is no existing record', () => {
    const incoming = snap({ status: 'no_new_data' })
    expect(mergeDailySnapshot(null, incoming)).toBe(incoming)
  })

  it('keeps a field the incoming push omits (null-only field merge)', () => {
    const existing = snap({ sleep: { durationMin: 420, startAt: 'a', endAt: 'b' } })
    const incoming = snap({ vitals: { restingHr: 52 } }) // no sleep
    const merged = mergeDailySnapshot(existing, incoming)
    expect(merged.sleep?.durationMin).toBe(420) // preserved
    expect(merged.vitals?.restingHr).toBe(52) // added
  })

  it('treats an explicit null field as absent (no field-delete signal)', () => {
    const existing = snap({ sleep: { durationMin: 420, startAt: 'a', endAt: 'b' } })
    const incoming = { ...snap({ vitals: { restingHr: 50 } }), sleep: null } as unknown as ZeppDailySnapshot
    const merged = mergeDailySnapshot(existing, incoming)
    expect(merged.sleep?.durationMin).toBe(420) // explicit null did not wipe
  })

  it('REPLACES the workouts array (never appends -> no rolling-window double count)', () => {
    const existing = snap({ workouts: [{ type: 'running', startAt: 'a', durationSec: 1800 }] })
    const incoming = snap({ workouts: [{ type: 'walking', startAt: 'b', durationSec: 1200 }] })
    const merged = mergeDailySnapshot(existing, incoming)
    expect(merged.workouts).toHaveLength(1)
    expect(merged.workouts?.[0].type).toBe('walking')
  })

  it('keeps existing workouts when the incoming push carries an empty array', () => {
    const existing = snap({ workouts: [{ type: 'running', startAt: 'a', durationSec: 1800 }] })
    const incoming = snap({ status: 'no_new_data', workouts: [] })
    const merged = mergeDailySnapshot(existing, incoming)
    expect(merged.workouts).toHaveLength(1)
    expect(merged.workouts?.[0].type).toBe('running')
  })

  it('recomputes an empty no_new_data push over an ok record back to ok (no status downgrade)', () => {
    const existing = snap({ status: 'ok', vitals: { restingHr: 52 } })
    const incoming = snap({ status: 'no_new_data' }) // empty
    const merged = mergeDailySnapshot(existing, incoming)
    expect(merged.status).toBe('ok')
    expect(merged.vitals?.restingHr).toBe(52)
  })

  it('always advances pulledAt to the latest write (silent-guard visibility)', () => {
    const existing = snap({ pulledAt: '2026-08-22T06:00:00.000Z', vitals: { restingHr: 52 } })
    const incoming = snap({ pulledAt: '2026-08-22T20:00:00.000Z', status: 'no_new_data' })
    const merged = mergeDailySnapshot(existing, incoming)
    expect(merged.pulledAt).toBe('2026-08-22T20:00:00.000Z')
  })

  // Cross-path (AC-A8 test 6): Path A writes ok, then a Path B pull fails auth for the same
  // day. The failed pull carries no data; it must NOT clobber the stored ok record. The
  // alert still fires from the raw pull result (health-guard), not from the merged file.
  it('does not let an auth_fail pull downgrade an existing ok record', () => {
    const existing = snap({ status: 'ok', vitals: { restingHr: 52 }, sleep: { durationMin: 420, startAt: 'a', endAt: 'b' } })
    const incoming = snap({ status: 'auth_fail', error: 'token expired' })
    const merged = mergeDailySnapshot(existing, incoming)
    expect(merged.status).toBe('ok') // good data survives
    expect(merged.vitals?.restingHr).toBe(52)
    expect(merged.sleep?.durationMin).toBe(420)
    expect(merged.error).toBeUndefined() // stale error not surfaced onto a good day
  })

  it('surfaces an auth_fail as-is when there is no prior good record to protect', () => {
    const existing = snap({ status: 'no_new_data' }) // no data
    const incoming = snap({ status: 'auth_fail', error: 'token expired' })
    const merged = mergeDailySnapshot(existing, incoming)
    expect(merged.status).toBe('auth_fail')
    expect(merged.error).toBe('token expired')
  })

  it('clears a stale error once a later push brings data back', () => {
    const existing = snap({ status: 'auth_fail', error: 'token expired' })
    const incoming = snap({ status: 'ok', vitals: { restingHr: 55 } })
    const merged = mergeDailySnapshot(existing, incoming)
    expect(merged.status).toBe('ok')
    expect(merged.error).toBeUndefined()
  })
})
