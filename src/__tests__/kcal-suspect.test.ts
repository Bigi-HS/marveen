// activeKcal plausibility label (card 75337cdc, code-side safety-net).
//
// The measured activeKcal arrives implausibly low for the day's steps (activeKcal=5 at
// 15,790 steps, 2026-08-25) because the upstream producer drops most active-calorie data
// while steps survive -- the same cross-field asymmetry as the distance loss (BUG-2). We
// cannot synthesise a trustworthy kcal fallback (active burn depends on weight/intensity,
// not steps alone), so instead of a fabricated number we LABEL the value suspect and leave
// the measured activeKcal untouched, so the dynamic calorie-goal consumer can decline to
// build a target off garbage. The plausibility Rule 1 (health-plausibility.ts) DETECTS the
// same anomaly; this module is the label + consumer accessor, mirroring distance-estimate.

import { describe, it, expect } from 'vitest'
import { applyKcalSuspectLabel, activeKcalForGoal } from '../web/zepp/kcal-suspect.js'
import type { ZeppDailySnapshot } from '../web/zepp/contract.js'

function snap(over: Partial<ZeppDailySnapshot>): ZeppDailySnapshot {
  return { date: '2026-08-25', pulledAt: '2026-08-25T10:00:00Z', status: 'ok', ...over }
}

describe('applyKcalSuspectLabel', () => {
  it('labels suspect when activeKcal is implausibly low for the steps (real 08-25 garbage)', () => {
    const out = applyKcalSuspectLabel(
      snap({ steps: 15790, activity: { activeKcal: 5, distanceM: 456 } }),
    )
    expect(out.activity?.activeKcalSuspect).toBe(true)
    // The measured value is never overwritten -- only labelled.
    expect(out.activity?.activeKcal).toBe(5)
  })

  it('does not label a plausible full active day (app-truth shape: 1011 kcal / 13694 steps)', () => {
    const out = applyKcalSuspectLabel(
      snap({ steps: 13694, activity: { activeKcal: 1011 } }),
    )
    expect(out.activity?.activeKcalSuspect).toBeUndefined()
    expect(out.activity?.activeKcal).toBe(1011)
  })

  it('does not label a plausible low-activity day (real 08-26: 51 kcal / 1376 steps)', () => {
    const out = applyKcalSuspectLabel(
      snap({ steps: 1376, activity: { activeKcal: 51, distanceM: 407 } }),
    )
    expect(out.activity?.activeKcalSuspect).toBeUndefined()
  })

  it('is self-correcting: a stale suspect flag is dropped when a later push is plausible', () => {
    const out = applyKcalSuspectLabel(
      snap({ steps: 13694, activity: { activeKcal: 1011, activeKcalSuspect: true } }),
    )
    expect(out.activity?.activeKcalSuspect).toBeUndefined()
  })

  it('does not label when activeKcal is absent (nothing to judge)', () => {
    const out = applyKcalSuspectLabel(snap({ steps: 15790, activity: { distanceM: 456 } }))
    expect(out.activity?.activeKcalSuspect).toBeUndefined()
  })

  it('does not label when steps are absent (no denominator)', () => {
    const out = applyKcalSuspectLabel(snap({ activity: { activeKcal: 5 } }))
    expect(out.activity?.activeKcalSuspect).toBeUndefined()
  })

  it('returns a snapshot with no activity block unchanged', () => {
    const s = snap({ steps: 15790 })
    expect(applyKcalSuspectLabel(s)).toEqual(s)
  })

  it('is pure: the input snapshot is not mutated', () => {
    const input = snap({ steps: 15790, activity: { activeKcal: 5 } })
    applyKcalSuspectLabel(input)
    expect(input.activity?.activeKcalSuspect).toBeUndefined()
  })
})

describe('activeKcalForGoal', () => {
  it('reports the measured kcal and suspect=true for a flagged day', () => {
    expect(activeKcalForGoal({ activeKcal: 5, activeKcalSuspect: true })).toEqual({
      kcal: 5,
      suspect: true,
    })
  })

  it('reports suspect=false for a clean day', () => {
    expect(activeKcalForGoal({ activeKcal: 1011 })).toEqual({ kcal: 1011, suspect: false })
  })

  it('reports suspect=false with undefined kcal for a missing activity block', () => {
    expect(activeKcalForGoal(undefined)).toEqual({ kcal: undefined, suspect: false })
  })
})
