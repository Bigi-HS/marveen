// Step-derived distance estimate (WELL-028 / WELL-026, Boss-requested remediation).
//
// When the measured HC distance arrives implausibly short for the day's steps (the BUG-2
// cross-field anomaly: 456 m at 15,790 steps), we surface a step-derived ESTIMATE instead
// of the broken measured number -- but never overwrite the measured field, and always label
// the estimate as an estimate (absence-of-errors discipline). The G3 plausibility rule
// DETECTS the anomaly; this module is the REMEDIATION.

import { describe, it, expect } from 'vitest'
import {
  applyDistanceEstimate,
  distanceForDisplay,
  DEFAULT_STRIDE_M,
  LOW_DISTANCE_RATIO,
  MIN_STEPS_FOR_ESTIMATE,
  MAX_ESTIMATE_M,
} from '../web/zepp/distance-estimate.js'
import type { ZeppDailySnapshot } from '../web/zepp/contract.js'

function snap(over: Partial<ZeppDailySnapshot>): ZeppDailySnapshot {
  return { date: '2026-08-25', pulledAt: '2026-08-25T10:00:00Z', status: 'ok', ...over }
}

describe('applyDistanceEstimate', () => {
  it('estimates from steps when the measured distance is implausibly short (BUG-2 day)', () => {
    const out = applyDistanceEstimate(
      snap({ steps: 15790, activity: { distanceM: 456, activeKcal: 500 } }),
    )
    expect(out.activity?.distanceSource).toBe('step_estimated')
    // round(15790 * 0.762) = 12032, close to the Boss-visible 12040
    expect(out.activity?.estimatedDistanceM).toBe(12032)
    // the measured field is NEVER overwritten
    expect(out.activity?.distanceM).toBe(456)
  })

  it('labels a plausible measured distance as measured, with no estimate (reference day)', () => {
    const out = applyDistanceEstimate(
      snap({ steps: 13694, activity: { distanceM: 12040 } }),
    )
    expect(out.activity?.distanceSource).toBe('measured')
    expect(out.activity?.estimatedDistanceM).toBeUndefined()
    expect(out.activity?.distanceM).toBe(12040)
  })

  it('estimates when steps are present but distance is entirely absent', () => {
    const out = applyDistanceEstimate(snap({ steps: 13694, activity: { activeKcal: 400 } }))
    expect(out.activity?.distanceSource).toBe('step_estimated')
    expect(out.activity?.estimatedDistanceM).toBe(Math.round(13694 * DEFAULT_STRIDE_M)) // 10435
    expect(out.activity?.distanceM).toBeUndefined()
  })

  it('does not estimate on a low-step day (shortfall immaterial, near-zero distance is plausible)', () => {
    const out = applyDistanceEstimate(snap({ steps: 200, activity: { distanceM: 0 } }))
    expect(out.activity?.distanceSource).toBe('measured')
    expect(out.activity?.estimatedDistanceM).toBeUndefined()
  })

  it('does not estimate without a steps count (nothing to derive from)', () => {
    const out = applyDistanceEstimate(snap({ activity: { distanceM: 456 } }))
    expect(out.activity?.distanceSource).toBe('measured')
    expect(out.activity?.estimatedDistanceM).toBeUndefined()
    expect(out.activity?.distanceM).toBe(456)
  })

  it('leaves a snapshot without an activity block untouched', () => {
    const s = snap({ steps: 15790 })
    const out = applyDistanceEstimate(s)
    expect(out.activity).toBeUndefined()
  })

  it('honours a calibrated stride override', () => {
    const out = applyDistanceEstimate(
      snap({ steps: 10000, activity: { distanceM: 100 } }),
      { strideM: 0.8 },
    )
    expect(out.activity?.estimatedDistanceM).toBe(8000)
  })

  it('is strict at the trigger boundary (ratio == LOW_DISTANCE_RATIO does not trip)', () => {
    const steps = 10000
    const atBoundary = applyDistanceEstimate(
      snap({ steps, activity: { distanceM: steps * LOW_DISTANCE_RATIO } }),
    )
    expect(atBoundary.activity?.distanceSource).toBe('measured')

    const justBelow = applyDistanceEstimate(
      snap({ steps, activity: { distanceM: steps * LOW_DISTANCE_RATIO - 1 } }),
    )
    expect(justBelow.activity?.distanceSource).toBe('step_estimated')
  })

  it('estimates exactly at the minimum-steps floor', () => {
    const out = applyDistanceEstimate(
      snap({ steps: MIN_STEPS_FOR_ESTIMATE, activity: { distanceM: 0 } }),
    )
    expect(out.activity?.distanceSource).toBe('step_estimated')
  })

  it('does not mutate its input (purity)', () => {
    const s = snap({ steps: 15790, activity: { distanceM: 456 } })
    const frozen = JSON.parse(JSON.stringify(s))
    applyDistanceEstimate(s)
    expect(s).toEqual(frozen)
  })

  it('is idempotent and self-correcting: a later real distance drops a stale estimate', () => {
    const estimated = applyDistanceEstimate(
      snap({ steps: 15790, activity: { distanceM: 456 } }),
    )
    expect(estimated.activity?.distanceSource).toBe('step_estimated')
    // re-applying the same input is stable
    expect(applyDistanceEstimate(estimated)).toEqual(estimated)
    // once the measured distance catches up, the estimate is dropped and the label flips back
    const corrected = applyDistanceEstimate(
      snap({ steps: 15790, activity: { ...estimated.activity, distanceM: 12000 } }),
    )
    expect(corrected.activity?.distanceSource).toBe('measured')
    expect(corrected.activity?.estimatedDistanceM).toBeUndefined()
  })

  it('preserves the distance slice-ledger untouched', () => {
    const slices = [{ startAt: '2026-08-25T10:00:00Z', meters: 456 }]
    const out = applyDistanceEstimate(
      snap({ steps: 15790, activity: { distanceM: 456, distanceSlices: slices } }),
    )
    expect(out.activity?.distanceSlices).toEqual(slices)
  })

  // AC#5 (G4 defense-in-depth): the derived estimate must be capped at MAX_ESTIMATE_M
  // even if the input step-count somehow slips past the input-cap (AC#1). This ensures
  // a monotone-max lock never preserves a 100+km phantom distance.
  describe('AC#5: derived estimate ceiling (defense-in-depth)', () => {
    it('caps estimatedDistanceM at MAX_ESTIMATE_M when steps * stride exceeds it', () => {
      // steps = 200,000 with 0.762 stride = 152,400m > MAX_ESTIMATE_M; must be clamped.
      const out = applyDistanceEstimate(
        snap({ steps: 200_000, activity: { distanceM: 0 } }),
      )
      expect(out.activity?.distanceSource).toBe('step_estimated')
      expect(out.activity?.estimatedDistanceM).toBe(MAX_ESTIMATE_M)
    })

    it('does NOT cap a plausible estimate below MAX_ESTIMATE_M', () => {
      // 15,790 steps * 0.762 = 12,032m -- well below the cap
      const out = applyDistanceEstimate(
        snap({ steps: 15790, activity: { distanceM: 456 } }),
      )
      expect(out.activity?.estimatedDistanceM).toBe(12032)
      expect((out.activity?.estimatedDistanceM ?? 0)).toBeLessThan(MAX_ESTIMATE_M)
    })

    it('is idempotent with the cap: re-applying on a capped snapshot stays capped', () => {
      const first = applyDistanceEstimate(snap({ steps: 200_000, activity: { distanceM: 0 } }))
      expect(first.activity?.estimatedDistanceM).toBe(MAX_ESTIMATE_M)
      const second = applyDistanceEstimate(first)
      expect(second.activity?.estimatedDistanceM).toBe(MAX_ESTIMATE_M)
    })
  })
})

describe('distanceForDisplay', () => {
  it('returns the estimate with its source when step-estimated', () => {
    const out = applyDistanceEstimate(
      snap({ steps: 15790, activity: { distanceM: 456 } }),
    )
    expect(distanceForDisplay(out.activity)).toEqual({ meters: 12032, source: 'step_estimated' })
  })

  it('returns the measured value with its source on a normal day', () => {
    const out = applyDistanceEstimate(snap({ steps: 13694, activity: { distanceM: 12040 } }))
    expect(distanceForDisplay(out.activity)).toEqual({ meters: 12040, source: 'measured' })
  })

  it('returns undefined when there is no distance to show', () => {
    expect(distanceForDisplay(undefined)).toBeUndefined()
    expect(distanceForDisplay({ activeKcal: 100 })).toBeUndefined()
  })
})
