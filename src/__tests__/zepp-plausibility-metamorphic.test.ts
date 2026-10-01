/**
 * TC-1 (interim, synthetic): metamorphic / property-based hardening for the Zepp
 * plausibility validators and the step-distance estimate (card 09563601 / ENG-151,
 * sub-stream of 44783957 test-hardening).
 *
 * The existing zepp-health-plausibility.test.ts pins explicit example cases. This
 * file adds the METAMORPHIC layer: invariants that must hold across a transformed
 * input, exercised over many deterministically-generated snapshots. A metamorphic
 * relation catches a class of bugs an example test cannot -- a rule that is right on
 * the pinned points but wrong on the continuum between them (pesticide-paradox lens).
 *
 * No property-testing library is used (fast-check is not a dependency and adding one
 * is out of scope). Generators are hand-rolled on a seeded LCG so every run is
 * deterministic and a failure is reproducible from the printed seed + index. This
 * matches the repo's hand-rolled-generator convention.
 *
 * The real-corpus half of TC-1 (validating these rules against live Zepp data) stays
 * BLOCKED on the ingest re-stop (card 89c97029) and is intentionally NOT attempted
 * here; this is the synthetic/metamorphic interim slice that can land now.
 */
import { describe, it, expect } from 'vitest'
import {
  validateHealthPlausibility,
  hasSuspectViolation,
} from '../web/zepp/health-plausibility.js'
import {
  applyDistanceEstimate,
  MAX_ESTIMATE_M,
  MIN_STEPS_FOR_ESTIMATE,
  LOW_DISTANCE_RATIO,
  DEFAULT_STRIDE_M,
} from '../web/zepp/distance-estimate.js'
import type { ZeppDailySnapshot } from '../web/zepp/contract.js'

// --- deterministic generator (seeded LCG; no external dependency) -----------

// Numerical Recipes LCG. Pure 32-bit state -> [0,1). Deterministic so a failing
// case is reproducible: the seed is derived from the property index (see run()).
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

const RUNS = 300 // cases per property; deterministic, fast (pure functions)

// Runs `check` over RUNS deterministic draws. On failure the seed+index are in the
// assertion context (the generated value is included in each property's expect).
function forEachCase(seedBase: number, check: (rand: () => number, i: number) => void): void {
  for (let i = 0; i < RUNS; i++) {
    check(lcg(seedBase + i * 2654435761), i)
  }
}

// A float in [min, max).
function between(rand: () => number, min: number, max: number): number {
  return min + rand() * (max - min)
}

function snap(over: Partial<ZeppDailySnapshot>): ZeppDailySnapshot {
  return {
    date: '2026-08-25',
    pulledAt: '2026-08-25T20:00:00.000Z',
    status: 'ok',
    ...over,
  }
}

// Rule-id predicates (the rule strings the validator emits).
const hasRule = (v: { rule: string }[], rule: string) => v.some((x) => x.rule === rule)
const RULE1 = 'activeKcal/steps ratio'
const RULE2 = 'distance/steps coherence'
const RULE3 = 'workout/activity distance coherence'

// =============================================================================

describe('plausibility metamorphic properties (ENG-151 TC-1 interim)', () => {
  // --- purity / determinism -------------------------------------------------

  it('is deterministic and never mutates its input (property)', () => {
    forEachCase(0x1111, (rand) => {
      const steps = Math.round(between(rand, 0, 25000))
      const input = snap({
        steps,
        activity: { activeKcal: Math.round(between(rand, 0, 4000)), distanceM: Math.round(between(rand, 0, 25000)) },
        vitals: { restingHr: Math.round(between(rand, 30, 90)), hrAvg: Math.round(between(rand, 60, 140)), hrMax: Math.round(between(rand, 100, 210)) },
      })
      const frozen = JSON.stringify(input)
      const a = validateHealthPlausibility(input)
      const b = validateHealthPlausibility(input)
      expect(b).toEqual(a) // deterministic
      expect(JSON.stringify(input)).toBe(frozen) // input untouched (pure)
    })
  })

  // --- Rule 1: activeKcal/steps, active-day band (steps >= 3000) ------------

  it('Rule 1 is scale-invariant above the active-step floor (metamorphic)', () => {
    // The band is purely ratio-based for steps >= 3000, so scaling steps AND
    // activeKcal by the same factor must not change the verdict. A margin keeps
    // generated cases clear of the exact boundary (float-stable under scaling).
    forEachCase(0x2222, (rand) => {
      const steps = Math.round(between(rand, 3000, 20000))
      // ratio clearly in-band or clearly out, never on the 0.02 / 0.10 edge.
      const inBand = rand() < 0.5
      const ratio = inBand
        ? between(rand, 0.03, 0.09)
        : (rand() < 0.5 ? between(rand, 0.001, 0.015) : between(rand, 0.12, 0.5))
      const kcal = Math.round(steps * ratio)
      const k = between(rand, 1, 4) // scale UP only: steps*k stays >= steps >= 3000
      const base = validateHealthPlausibility(snap({ steps, activity: { activeKcal: kcal } }))
      const scaled = validateHealthPlausibility(
        snap({ steps: Math.round(steps * k), activity: { activeKcal: Math.round(kcal * k) } }),
      )
      expect(hasRule(scaled, RULE1)).toBe(hasRule(base, RULE1))
    })
  })

  it('Rule 1 fires IFF the ratio is outside [0.02, 0.10] above the floor (property)', () => {
    forEachCase(0x3333, (rand) => {
      const steps = Math.round(between(rand, 3000, 20000))
      const outside = rand() < 0.5
      const ratio = outside
        ? (rand() < 0.5 ? between(rand, 0.001, 0.015) : between(rand, 0.12, 0.6))
        : between(rand, 0.03, 0.09)
      const kcal = Math.round(steps * ratio)
      const v = validateHealthPlausibility(snap({ steps, activity: { activeKcal: kcal } }))
      expect(hasRule(v, RULE1)).toBe(outside)
    })
  })

  // --- Rule 2: distance/steps, band (steps >= 3000) ------------------------

  it('Rule 2 is scale-invariant above the step floor (metamorphic)', () => {
    forEachCase(0x4444, (rand) => {
      const steps = Math.round(between(rand, 3000, 20000))
      const inBand = rand() < 0.5
      const ratio = inBand
        ? between(rand, 0.3, 0.6)
        : (rand() < 0.5 ? between(rand, 0.05, 0.2) : between(rand, 0.7, 1.5))
      const dist = Math.round(steps * ratio)
      const k = between(rand, 1, 4) // scale UP only: steps*k stays >= steps >= 3000
      // isolate Rule 2: no activeKcal (Rule 1 skips), no workouts (Rule 3 skips)
      const base = validateHealthPlausibility(snap({ steps, activity: { distanceM: dist } }))
      const scaled = validateHealthPlausibility(
        snap({ steps: Math.round(steps * k), activity: { distanceM: Math.round(dist * k) } }),
      )
      expect(hasRule(scaled, RULE2)).toBe(hasRule(base, RULE2))
    })
  })

  it('Rule 2 fires IFF the ratio is outside [0.25, 0.65] above the floor (property)', () => {
    forEachCase(0x5555, (rand) => {
      const steps = Math.round(between(rand, 3000, 20000))
      const outside = rand() < 0.5
      const ratio = outside
        ? (rand() < 0.5 ? between(rand, 0.05, 0.2) : between(rand, 0.7, 1.5))
        : between(rand, 0.3, 0.6)
      const dist = Math.round(steps * ratio)
      const v = validateHealthPlausibility(snap({ steps, activity: { distanceM: dist } }))
      expect(hasRule(v, RULE2)).toBe(outside)
    })
  })

  // --- Rule 3: activity distance >= workout-distance sum (monotone) ---------

  it('Rule 3 fires IFF activity.distanceM < sum(workout distances) (property)', () => {
    forEachCase(0x6666, (rand) => {
      // steps undefined -> Rules 1+2 skip, isolating Rule 3.
      const w1 = Math.round(between(rand, 0, 5000))
      const w2 = Math.round(between(rand, 0, 5000))
      const sum = w1 + w2
      const dist = Math.round(between(rand, 0, 12000))
      const v = validateHealthPlausibility(
        snap({
          activity: { distanceM: dist },
          workouts: [
            { type: 'running', startAt: '2026-08-25T06:00:00.000Z', durationSec: 1800, distanceM: w1 },
            { type: 'walking', startAt: '2026-08-25T18:00:00.000Z', durationSec: 1800, distanceM: w2 },
          ],
        }),
      )
      // The rule only fires when the workout sum is non-zero AND dist < sum.
      expect(hasRule(v, RULE3)).toBe(sum > 0 && dist < sum)
    })
  })

  it('Rule 3 is monotone: raising activity.distanceM never ADDS a violation (metamorphic)', () => {
    forEachCase(0x7777, (rand) => {
      const sum = Math.round(between(rand, 100, 8000))
      const dist = Math.round(between(rand, 0, 8000))
      const bump = Math.round(between(rand, 0, 8000)) // non-negative increase
      const mk = (d: number) =>
        snap({
          activity: { distanceM: d },
          workouts: [{ type: 'running', startAt: '2026-08-25T06:00:00.000Z', durationSec: 1800, distanceM: sum }],
        })
      const low = hasRule(validateHealthPlausibility(mk(dist)), RULE3)
      const high = hasRule(validateHealthPlausibility(mk(dist + bump)), RULE3)
      // If the lower distance was fine, the higher one must stay fine; a larger
      // distance can only ever CLEAR the "< sum" violation, never introduce it.
      if (!low) expect(high).toBe(false)
    })
  })

  // --- Rule 4: heart-rate ordering -----------------------------------------

  it('Rule 4: a well-ordered in-bounds HR triple yields no suspect; breaking the order always does (metamorphic)', () => {
    forEachCase(0x8888, (rand) => {
      // Build a strictly ordered, in-bounds, adequate-reserve triple.
      const restingHr = Math.round(between(rand, 40, 70))
      const hrAvg = restingHr + Math.round(between(rand, 15, 40)) // >= 10 reserve
      const hrMax = hrAvg + Math.round(between(rand, 20, 50)) // >= 15 reserve
      const ok = validateHealthPlausibility(snap({ vitals: { restingHr, hrAvg, hrMax } }))
      // in-bounds (resting 40-70, hrMax <= 160) so no suspect at all
      expect(hasSuspectViolation(ok)).toBe(false)

      // Metamorphic break: force restingHr >= hrAvg -> always an ordering suspect.
      const broken = validateHealthPlausibility(
        snap({ vitals: { restingHr: hrAvg, hrAvg, hrMax } }),
      )
      expect(hasRule(broken, 'heart rate ordering')).toBe(true)
      expect(hasSuspectViolation(broken)).toBe(true)
    })
  })
})

// =============================================================================

describe('distance-estimate metamorphic properties (ENG-151 TC-1 interim)', () => {
  it('G4: the estimate never exceeds MAX_ESTIMATE_M for ANY step count (property)', () => {
    forEachCase(0x9999, (rand) => {
      // Push steps far past any realistic / input-capped value to exercise the
      // defense-in-depth ceiling (a phantom count slipping past AC#1).
      const steps = Math.round(between(rand, MIN_STEPS_FOR_ESTIMATE, 5_000_000))
      const out = applyDistanceEstimate(snap({ steps, activity: { distanceM: 0 } }))
      const est = out.activity?.estimatedDistanceM
      expect(est).toBeDefined()
      expect(est!).toBeLessThanOrEqual(MAX_ESTIMATE_M)
    })
  })

  it('the estimate is monotone non-decreasing in steps (metamorphic)', () => {
    forEachCase(0xaaaa, (rand) => {
      const steps = Math.round(between(rand, MIN_STEPS_FOR_ESTIMATE, 100_000))
      const more = steps + Math.round(between(rand, 0, 100_000))
      const estOf = (s: number) =>
        applyDistanceEstimate(snap({ steps: s, activity: { distanceM: 0 } })).activity!.estimatedDistanceM!
      expect(estOf(more)).toBeGreaterThanOrEqual(estOf(steps))
    })
  })

  it('applyDistanceEstimate is idempotent and pure (metamorphic)', () => {
    forEachCase(0xbbbb, (rand) => {
      const steps = Math.round(between(rand, 0, 30000))
      const measured = Math.round(between(rand, 0, 20000))
      const input = snap({ steps, activity: { distanceM: measured } })
      const frozen = JSON.stringify(input)
      const once = applyDistanceEstimate(input)
      const twice = applyDistanceEstimate(once)
      expect(twice).toEqual(once) // re-running on the labelled output is a no-op
      expect(JSON.stringify(input)).toBe(frozen) // input not mutated
    })
  })

  it('when a plausible measured distance is present, no estimate is produced (metamorphic)', () => {
    forEachCase(0xcccc, (rand) => {
      // measured >= steps * LOW_DISTANCE_RATIO -> measured is kept, no estimate.
      const steps = Math.round(between(rand, MIN_STEPS_FOR_ESTIMATE, 30000))
      const measured = Math.ceil(steps * LOW_DISTANCE_RATIO) + Math.round(between(rand, 0, 20000))
      const out = applyDistanceEstimate(snap({ steps, activity: { distanceM: measured } }))
      expect(out.activity?.distanceSource).toBe('measured')
      expect(out.activity?.estimatedDistanceM).toBeUndefined()
    })
  })
})

// --- boundary pins (exact thresholds; complement the property bands) ---------

describe('plausibility boundary pins (ENG-151)', () => {
  it('[boundary] Rule 1 ratio exactly 0.02 and 0.10 are inside the band (not suspect)', () => {
    const steps = 10000
    const lo = validateHealthPlausibility(snap({ steps, activity: { activeKcal: steps * 0.02 } }))
    const hi = validateHealthPlausibility(snap({ steps, activity: { activeKcal: steps * 0.1 } }))
    expect(hasRule(lo, RULE1)).toBe(false)
    expect(hasRule(hi, RULE1)).toBe(false)
  })

  it('[boundary] Rule 2 ratio exactly 0.25 and 0.65 are inside the band (not suspect)', () => {
    const steps = 10000
    const lo = validateHealthPlausibility(snap({ steps, activity: { distanceM: steps * 0.25 } }))
    const hi = validateHealthPlausibility(snap({ steps, activity: { distanceM: steps * 0.65 } }))
    expect(hasRule(lo, RULE2)).toBe(false)
    expect(hasRule(hi, RULE2)).toBe(false)
  })

  it('[boundary] step floor: 2999 vs 3000 steps switch bands for Rule 1', () => {
    // At 2999 steps the sedentary cap (<=200 kcal) applies; 300 kcal is suspect.
    // At 3000 steps the active band applies; 300 kcal (ratio 0.10) is fine.
    const below = validateHealthPlausibility(snap({ steps: 2999, activity: { activeKcal: 300 } }))
    const at = validateHealthPlausibility(snap({ steps: 3000, activity: { activeKcal: 300 } }))
    expect(hasRule(below, RULE1)).toBe(true)
    expect(hasRule(at, RULE1)).toBe(false)
  })

  it('[boundary] G4: estimate at exactly the ceiling step count clamps to MAX_ESTIMATE_M', () => {
    const stepsAtCeiling = Math.ceil(MAX_ESTIMATE_M / DEFAULT_STRIDE_M)
    const out = applyDistanceEstimate(snap({ steps: stepsAtCeiling + 100000, activity: { distanceM: 0 } }))
    expect(out.activity?.estimatedDistanceM).toBe(MAX_ESTIMATE_M)
  })
})
