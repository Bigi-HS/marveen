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

// Distance slice-ledger (card 75337cdc distance=B, append-only accumulate).
//
// The HC distance records arrive as disjoint ~15-min intraday slices, and the 48h rolling
// window drops old slices from later pushes -- so the naive scalar-replace merge clobbered
// the day's distanceM DOWN to whatever the last (often single-slice) push carried (the
// live 456m-for-a-full-day symptom). The fix: accumulate the raw slices in an append-only
// per-day ledger keyed by startAt, and project distanceM = round(sum of deduped slices), so
// a later narrow-window push can never lower the total. Measured on 16 real pushes: the
// {105m,21:15Z} slice recurred byte-identical across 13 pushes (startAt is a stable dedup
// key) and slices tile the day without overlap (increment, not cumulative -> sum is correct).
describe('mergeDailySnapshot: distance slice-ledger', () => {
  const S1 = { startAt: '2026-08-25T21:15:00Z', endAt: '2026-08-25T21:30:00Z', meters: 105 }
  const S2 = { startAt: '2026-08-25T22:00:00Z', endAt: '2026-08-25T22:15:00Z', meters: 435 }
  const S3 = { startAt: '2026-08-26T04:30:00Z', endAt: '2026-08-26T04:45:00Z', meters: 407 }

  it('unions disjoint slices across pushes and projects distanceM = sum', () => {
    const existing = snap({ activity: { distanceSlices: [S1], distanceM: 105 } })
    const incoming = snap({ activity: { distanceSlices: [S2], distanceM: 435 } })
    const merged = mergeDailySnapshot(existing, incoming)
    expect(merged.activity?.distanceSlices).toHaveLength(2)
    expect(merged.activity?.distanceM).toBe(540)
  })

  it('dedups a repeated slice by startAt (no double count)', () => {
    const existing = snap({ activity: { distanceSlices: [S1, S2], distanceM: 540 } })
    const incoming = snap({ activity: { distanceSlices: [S1], distanceM: 105 } }) // S1 again
    const merged = mergeDailySnapshot(existing, incoming)
    expect(merged.activity?.distanceSlices).toHaveLength(2)
    expect(merged.activity?.distanceM).toBe(540) // not 645
  })

  // The core anti-clobber invariant: a later push whose 48h window dropped older slices must
  // NOT lower the day's total. This is the 456m-for-a-full-day bug, guarded.
  it('does NOT clobber the total down when a later push carries a narrower slice set', () => {
    const existing = snap({ activity: { distanceSlices: [S1, S2, S3], distanceM: 947 } })
    const incoming = snap({ activity: { distanceSlices: [S3], distanceM: 407 } }) // window shrank
    const merged = mergeDailySnapshot(existing, incoming)
    expect(merged.activity?.distanceSlices).toHaveLength(3)
    expect(merged.activity?.distanceM).toBe(947) // stays full, not clobbered to 407
  })

  it('lets an incoming slice correct a prior value for the same startAt', () => {
    const existing = snap({ activity: { distanceSlices: [{ ...S1, meters: 100 }], distanceM: 100 } })
    const incoming = snap({ activity: { distanceSlices: [{ ...S1, meters: 105 }], distanceM: 105 } })
    const merged = mergeDailySnapshot(existing, incoming)
    expect(merged.activity?.distanceSlices).toHaveLength(1)
    expect(merged.activity?.distanceM).toBe(105) // corrected value wins
  })

  it('projects distanceM from the ledger, ignoring a stale incoming scalar', () => {
    const existing = snap({ activity: { distanceSlices: [S1, S2], distanceM: 540 } })
    // A push that (wrongly) carries a tiny scalar but the full slice set must not down-rank.
    const incoming = snap({ activity: { distanceSlices: [S1, S2], distanceM: 12 } })
    const merged = mergeDailySnapshot(existing, incoming)
    expect(merged.activity?.distanceM).toBe(540) // projection, not the incoming 12
  })

  it('normalizes distanceM to the slice-sum on the first write of the day', () => {
    const incoming = snap({ activity: { distanceSlices: [S1, S2], distanceM: 999 } })
    const merged = mergeDailySnapshot(null, incoming)
    expect(merged.activity?.distanceM).toBe(540)
  })

  it('keeps the distance ledger when a later push carries other activity but no slices', () => {
    const existing = snap({ activity: { distanceSlices: [S1, S2], distanceM: 540 } })
    const incoming = snap({ activity: { activeKcal: 200 } }) // no distanceSlices
    const merged = mergeDailySnapshot(existing, incoming)
    expect(merged.activity?.distanceSlices).toHaveLength(2)
    expect(merged.activity?.distanceM).toBe(540)
    expect(merged.activity?.activeKcal).toBe(200)
  })

  it('falls back to scalar distanceM when no slice ledger is ever present (legacy path)', () => {
    const existing = snap({ activity: { distanceM: 500 } })
    const incoming = snap({ activity: { distanceM: 620 } })
    const merged = mergeDailySnapshot(existing, incoming)
    expect(merged.activity?.distanceSlices).toBeUndefined()
    expect(merged.activity?.distanceM).toBe(620) // scalar replace, unchanged behavior
  })

  it('does not erase an existing activity field when the incoming activity omits it', () => {
    const existing = snap({ activity: { activeKcal: 200, distanceSlices: [S1], distanceM: 105 } })
    const incoming = snap({ activity: { distanceSlices: [S2], distanceM: 435 } }) // no activeKcal
    const merged = mergeDailySnapshot(existing, incoming)
    expect(merged.activity?.activeKcal).toBe(200) // preserved
    expect(merged.activity?.distanceM).toBe(540)
  })

  // DA-L1 (audit-data-integrity-0826): a prior scalar-only distanceM (legacy write or a
  // concurrent scalar-only push from the dormant pull path) has no slice identity to dedup
  // against. When the ledger starts, keep the HIGHER of (prior scalar, ledger sum): the
  // scalar is never silently dropped, and an overlapping full-day scalar is not additively
  // double-counted with a slice tile that is part of it (so NOT 2500 -- the tile is inside
  // the 2000). Once the ledger sum exceeds the old scalar, the more precise ledger wins.
  it('does not silently drop a prior scalar distanceM when the ledger starts (DA-L1)', () => {
    const existing = snap({ activity: { distanceM: 2000 } }) // scalar only, no slices
    const incoming = snap({ activity: { distanceSlices: [S1], distanceM: 105 } })
    const merged = mergeDailySnapshot(existing, incoming)
    expect(merged.activity?.distanceM).toBe(2000) // prior scalar preserved (>105), not dropped
    expect(merged.activity?.distanceSlices).toHaveLength(1)
  })

  it('lets the ledger sum win once it exceeds a prior unbacked scalar (DA-L1)', () => {
    const existing = snap({ activity: { distanceM: 400 } })
    const incoming = snap({ activity: { distanceSlices: [S1, S2], distanceM: 540 } })
    const merged = mergeDailySnapshot(existing, incoming)
    expect(merged.activity?.distanceM).toBe(540) // ledger (540) > old scalar (400) -> ledger wins
  })

  // ---------------------------------------------------------------------------
  // Adversarial: coverage gaps found during 2026-08-26 QA sweep (card 75337cdc,
  // 351c80a7 Boss-direktiva). These fixtures document KNOWN GAPS so dave can see
  // exactly what breaks and fix it; each has a comment describing the expected fix.
  // ---------------------------------------------------------------------------

  // GAP-L1 (FIXED): activeKcal is a cumulative daily counter, so a later sparse push (5 kcal)
  // must not clobber a prior full-day value (1011). mergeActivity now keeps the max -- the
  // same no-clobber-down invariant the distance ledger gives distanceM, on the calorie axis.
  it('GAP-L1: a sparse activeKcal push does NOT clobber a prior full-day value (monotone-max)', () => {
    const existing = snap({ activity: { activeKcal: 1011, distanceSlices: [S1, S2], distanceM: 540 } })
    const incoming = snap({ activity: { activeKcal: 5, distanceSlices: [S3], distanceM: 407 } }) // late sparse push
    const merged = mergeDailySnapshot(existing, incoming)
    expect(merged.activity?.activeKcal).toBe(1011) // kept, not clobbered to 5 (live 08-25 symptom)
    expect(merged.activity?.distanceM).toBe(947) // ledger unchanged
  })

  it('GAP-L1: a HIGHER activeKcal push advances the daily total', () => {
    const existing = snap({ activity: { activeKcal: 200 } })
    const incoming = snap({ activity: { activeKcal: 350 } })
    const merged = mergeDailySnapshot(existing, incoming)
    expect(merged.activity?.activeKcal).toBe(350) // cumulative counter grows
  })

  it('GAP-L1: a push without activeKcal keeps the prior value', () => {
    const existing = snap({ activity: { activeKcal: 1011, distanceSlices: [S1], distanceM: 105 } })
    const incoming = snap({ activity: { distanceSlices: [S2], distanceM: 435 } }) // no activeKcal
    const merged = mergeDailySnapshot(existing, incoming)
    expect(merged.activity?.activeKcal).toBe(1011) // preserved
  })

  // GAP-L2 (FIXED): steps is a cumulative daily counter; a partial rolling-window push
  // (steps=60, yesterday's leftover) must not clobber a prior full-day total (15790).
  // Keep the max -- the same interim monotone guard as activeKcal.
  it('GAP-L2: a partial steps push does NOT clobber a prior full-day total (monotone-max)', () => {
    const existing = snap({ steps: 15790, activity: { distanceSlices: [S1, S2], distanceM: 540 } })
    const incoming = snap({ steps: 60, activity: { distanceSlices: [S3], distanceM: 407 } }) // partial window
    const merged = mergeDailySnapshot(existing, incoming)
    expect(merged.steps).toBe(15790) // kept, not clobbered to 60
  })

  it('GAP-L2: a HIGHER steps push advances the daily total', () => {
    const existing = snap({ steps: 8000 })
    const incoming = snap({ steps: 12500 })
    const merged = mergeDailySnapshot(existing, incoming)
    expect(merged.steps).toBe(12500) // cumulative counter grows
  })

  it('GAP-L2: a push without steps keeps the prior total', () => {
    const existing = snap({ steps: 15790 })
    const incoming = snap({ vitals: { restingHr: 55 } }) // no steps
    const merged = mergeDailySnapshot(existing, incoming)
    expect(merged.steps).toBe(15790) // preserved
  })

  // GAP-L3: zero-meter slice -- should not corrupt the total.
  // A sensor glitch can emit meters=0; it should contribute 0 to the sum (not break).
  // A negative meter slice (bad GPS) would lower the total -- no current guard exists.
  it('GAP-L3: a zero-meter slice is stored and contributes 0 to the sum (not a crash)', () => {
    const S0 = { startAt: '2026-08-25T20:00:00Z', endAt: '2026-08-25T20:15:00Z', meters: 0 }
    const existing = snap({ activity: { distanceSlices: [S1], distanceM: 105 } })
    const incoming = snap({ activity: { distanceSlices: [S0], distanceM: 0 } })
    const merged = mergeDailySnapshot(existing, incoming)
    expect(merged.activity?.distanceSlices).toHaveLength(2)
    expect(merged.activity?.distanceM).toBe(105) // S0 contributes 0, total unchanged
  })
})
