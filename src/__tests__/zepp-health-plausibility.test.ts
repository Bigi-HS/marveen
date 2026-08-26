import { describe, it, expect } from 'vitest'
import {
  validateHealthPlausibility,
  hasSuspectViolation,
} from '../web/zepp/health-plausibility.js'
import type { ZeppDailySnapshot } from '../web/zepp/contract.js'

function snap(over: Partial<ZeppDailySnapshot>): ZeppDailySnapshot {
  return {
    date: '2026-08-25',
    pulledAt: '2026-08-25T20:00:00.000Z',
    status: 'ok',
    ...over,
  }
}

describe('validateHealthPlausibility', () => {
  describe('Rule 1: activeKcal vs steps', () => {
    // The live 2026-08-25 garbage: 5 kcal at 15,790 steps (ratio 0.0003).
    it('flags absurdly low activeKcal for a high step count (live 08-25 bug)', () => {
      const v = validateHealthPlausibility(snap({ steps: 15790, activity: { activeKcal: 5 } }))
      expect(hasSuspectViolation(v)).toBe(true)
      expect(v.some((x) => x.rule === 'activeKcal/steps ratio')).toBe(true)
    })

    it('accepts a healthy activeKcal/steps ratio (1000 kcal @ 15,790 steps)', () => {
      const v = validateHealthPlausibility(
        snap({ steps: 15790, activity: { activeKcal: 1000, distanceM: 12000 } }),
      )
      expect(v.some((x) => x.rule === 'activeKcal/steps ratio')).toBe(false)
    })

    it('flags an impossibly high activeKcal for the step count', () => {
      const v = validateHealthPlausibility(snap({ steps: 5000, activity: { activeKcal: 5000 } }))
      expect(hasSuspectViolation(v)).toBe(true)
    })

    it('allows a sedentary day (2,000 steps, 50 kcal)', () => {
      const v = validateHealthPlausibility(snap({ steps: 2000, activity: { activeKcal: 50 } }))
      expect(v.some((x) => x.rule === 'activeKcal/steps ratio')).toBe(false)
    })

    it('flags >200 kcal on a near-zero-step day', () => {
      const v = validateHealthPlausibility(snap({ steps: 500, activity: { activeKcal: 400 } }))
      expect(hasSuspectViolation(v)).toBe(true)
    })

    it('ignores activeKcal when steps below the 100 floor', () => {
      const v = validateHealthPlausibility(snap({ steps: 50, activity: { activeKcal: 999 } }))
      expect(v.some((x) => x.rule === 'activeKcal/steps ratio')).toBe(false)
    })

    it('does not check the ratio when activeKcal is absent', () => {
      const v = validateHealthPlausibility(snap({ steps: 15790, activity: { distanceM: 12000 } }))
      expect(v.some((x) => x.rule === 'activeKcal/steps ratio')).toBe(false)
    })
  })

  describe('Rule 2: distance vs steps', () => {
    // The live 2026-08-25 garbage: 456m at 15,790 steps (ratio 0.029, ~3cm/step).
    it('flags absurdly low distance for a high step count (live 08-25 bug)', () => {
      const v = validateHealthPlausibility(snap({ steps: 15790, activity: { distanceM: 456 } }))
      expect(hasSuspectViolation(v)).toBe(true)
      expect(v.some((x) => x.rule === 'distance/steps coherence')).toBe(true)
    })

    it('accepts a healthy stride (0.75 m/step)', () => {
      const v = validateHealthPlausibility(snap({ steps: 10000, activity: { distanceM: 7500 } }))
      expect(v.some((x) => x.rule === 'distance/steps coherence')).toBe(false)
    })

    it('flags an impossibly long distance for the step count (GPS error)', () => {
      const v = validateHealthPlausibility(snap({ steps: 10000, activity: { distanceM: 50000 } }))
      expect(hasSuspectViolation(v)).toBe(true)
    })

    it('does not check coherence when distance is absent', () => {
      const v = validateHealthPlausibility(snap({ steps: 15790, activity: { activeKcal: 1000 } }))
      expect(v.some((x) => x.rule === 'distance/steps coherence')).toBe(false)
    })
  })

  describe('Rule 4: heart rate sanity', () => {
    it('flags restingHr >= hrAvg', () => {
      const v = validateHealthPlausibility(snap({ vitals: { restingHr: 70, hrAvg: 65, hrMax: 150 } }))
      expect(v.some((x) => x.rule === 'heart rate ordering')).toBe(true)
    })

    it('flags hrAvg >= hrMax', () => {
      const v = validateHealthPlausibility(snap({ vitals: { restingHr: 55, hrAvg: 150, hrMax: 140 } }))
      expect(v.some((x) => x.rule === 'heart rate ordering')).toBe(true)
    })

    it('flags a pathologically low resting HR', () => {
      const v = validateHealthPlausibility(snap({ vitals: { restingHr: 30 } }))
      expect(v.some((x) => x.rule === 'heart rate bounds')).toBe(true)
    })

    it('flags a flat hrMin == hrMax', () => {
      const v = validateHealthPlausibility(snap({ vitals: { hrMin: 120, hrMax: 120 } }))
      expect(v.some((x) => x.rule === 'heart rate flatness')).toBe(true)
    })

    it('accepts a healthy HR profile', () => {
      const v = validateHealthPlausibility(
        snap({ vitals: { restingHr: 52, hrAvg: 78, hrMax: 165, hrMin: 48 } }),
      )
      expect(hasSuspectViolation(v)).toBe(false)
    })
  })

  describe('overall', () => {
    it('returns no violations for a fully coherent day', () => {
      const v = validateHealthPlausibility(
        snap({
          steps: 13694,
          activity: { activeKcal: 1011, distanceM: 12040 },
          vitals: { restingHr: 52, hrAvg: 78, hrMax: 165 },
        }),
      )
      expect(v).toHaveLength(0)
    })

    it('returns no violations for a snapshot with no numeric data (rest day)', () => {
      const v = validateHealthPlausibility(snap({ sleep: { durationMin: 420, startAt: '', endAt: '' } }))
      expect(v).toHaveLength(0)
    })

    it('catches the DA falsifier #3 absurd push (kcal=3, dist=1, steps=20000)', () => {
      const v = validateHealthPlausibility(snap({ steps: 20000, activity: { activeKcal: 3, distanceM: 1 } }))
      expect(hasSuspectViolation(v)).toBe(true)
      // both activity rules trip
      expect(v.some((x) => x.rule === 'activeKcal/steps ratio')).toBe(true)
      expect(v.some((x) => x.rule === 'distance/steps coherence')).toBe(true)
    })
  })

  // Adversarial fixtures: FP-catch, FN-catch, opposing pair (card 44783957 / test-hardening).
  // Purpose: (1) document known calibration-risk boundary cases; (2) verify the threshold math;
  // (3) ensure the guard does NOT fire on valid physiological edge cases it wasn't designed to block.
  describe('adversarial fixtures (FP-catch / FN-catch / boundary / opposing pair)', () => {
    // --- FP-catch: boundary precision ---
    // Rule 2: lower bound is steps*0.5 for >=3000 steps. 3000*0.5=1500 exactly must NOT flag.
    it('[FP-catch] Rule 2: exactly at lower-bound stride (3000 steps, 1500m = 0.5 m/step) is NOT suspect', () => {
      const v = validateHealthPlausibility(snap({ steps: 3000, activity: { distanceM: 1500 } }))
      expect(v.some((x) => x.rule === 'distance/steps coherence')).toBe(false)
    })

    // Rule 2: upper bound is steps*0.9. 10000*0.9=9000 exactly must NOT flag.
    it('[FP-catch] Rule 2: exactly at upper-bound stride (10000 steps, 9000m = 0.9 m/step) is NOT suspect', () => {
      const v = validateHealthPlausibility(snap({ steps: 10000, activity: { distanceM: 9000 } }))
      expect(v.some((x) => x.rule === 'distance/steps coherence')).toBe(false)
    })

    // Rule 1: upper bound is steps*0.2. 3000*0.2=600 exactly must NOT flag.
    it('[FP-catch] Rule 1: exactly at upper-bound kcal (3000 steps, 600 kcal = 0.20 ratio) is NOT suspect', () => {
      const v = validateHealthPlausibility(snap({ steps: 3000, activity: { activeKcal: 600 } }))
      expect(v.some((x) => x.rule === 'activeKcal/steps ratio')).toBe(false)
    })

    // Rule 2: known calibration risk -- a tall runner with long strides can exceed 0.9 m/step.
    // 5000 steps at 0.94 m/step = 4700m: physiologically valid for ~190cm athlete.
    // The guard WILL flag this -- document it so the threshold can be recalibrated if Boss data shows it.
    it('[FP-calibration-risk] Rule 2: tall-runner long strides (5000 steps, 4700m = 0.94 m/step) IS flagged', () => {
      const v = validateHealthPlausibility(snap({ steps: 5000, activity: { distanceM: 4700 } }))
      // This fires suspect -- known FP risk at upper stride bound. Calibration note: upper bound = 0.9 m/step
      // may need adjustment if Dominik's real running data hits this range.
      expect(v.some((x) => x.rule === 'distance/steps coherence')).toBe(true)
    })

    // --- FN-catch: just past the threshold ---
    // Rule 2: 3000 steps, 1499m = 0.4997 m/step -> just below lower bound -> MUST flag.
    it('[FN-catch] Rule 2: 1m below lower bound (3000 steps, 1499m) IS suspect', () => {
      const v = validateHealthPlausibility(snap({ steps: 3000, activity: { distanceM: 1499 } }))
      expect(v.some((x) => x.rule === 'distance/steps coherence')).toBe(true)
    })

    // Rule 2: 10000 steps, 9001m -> 1m over upper bound -> MUST flag.
    it('[FN-catch] Rule 2: 1m above upper bound (10000 steps, 9001m) IS suspect', () => {
      const v = validateHealthPlausibility(snap({ steps: 10000, activity: { distanceM: 9001 } }))
      expect(v.some((x) => x.rule === 'distance/steps coherence')).toBe(true)
    })

    // --- Floor-edge: steps=100 is AT the floor, so ratio IS checked. steps=99 is exempt.
    it('[FP-catch] Rule 1+2: steps=99 exempt from ratio checks regardless of kcal/distance', () => {
      const v = validateHealthPlausibility(snap({ steps: 99, activity: { activeKcal: 9999, distanceM: 9999 } }))
      expect(v.some((x) => x.rule === 'activeKcal/steps ratio')).toBe(false)
      expect(v.some((x) => x.rule === 'distance/steps coherence')).toBe(false)
    })

    it('[FN-catch] Rule 1+2: steps=100 is NOT exempt -- absurd kcal/distance IS flagged', () => {
      const v = validateHealthPlausibility(snap({ steps: 100, activity: { activeKcal: 9999, distanceM: 9999 } }))
      expect(hasSuspectViolation(v)).toBe(true)
    })

    // --- Opposing pair: selective rule fire ---
    // Valid kcal but absurd distance -> only Rule 2 fires, Rule 1 silent.
    // Critical: the guard must not suppress a partial anomaly behind a passing sibling rule.
    it('[opposing-pair] valid kcal + absurd distance: Rule 2 fires, Rule 1 silent', () => {
      // 10000 steps, 400 kcal (ratio 0.04, in [0.03, 0.20] -> Rule 1 PASS)
      // 10000 steps, 100m (ratio 0.01, < 0.5 -> Rule 2 SUSPECT)
      const v = validateHealthPlausibility(snap({ steps: 10000, activity: { activeKcal: 400, distanceM: 100 } }))
      expect(v.some((x) => x.rule === 'activeKcal/steps ratio')).toBe(false) // Rule 1 silent
      expect(v.some((x) => x.rule === 'distance/steps coherence')).toBe(true) // Rule 2 fires
      expect(hasSuspectViolation(v)).toBe(true)
    })

    // Absurd kcal but valid distance -> only Rule 1 fires, Rule 2 silent.
    it('[opposing-pair] absurd kcal + valid distance: Rule 1 fires, Rule 2 silent', () => {
      // 10000 steps, 5 kcal (ratio 0.0005, < 0.03 -> Rule 1 SUSPECT)
      // 10000 steps, 7500m (ratio 0.75 in [0.5, 0.9] -> Rule 2 PASS)
      const v = validateHealthPlausibility(snap({ steps: 10000, activity: { activeKcal: 5, distanceM: 7500 } }))
      expect(v.some((x) => x.rule === 'activeKcal/steps ratio')).toBe(true) // Rule 1 fires
      expect(v.some((x) => x.rule === 'distance/steps coherence')).toBe(false) // Rule 2 silent
      expect(hasSuspectViolation(v)).toBe(true)
    })

    // <3000 steps sub-branch: ratio=0.4 exactly is NOT flagged (strict less-than), 0.399 IS.
    it('[FP-catch] Rule 2 <3000 branch: ratio=0.4 exactly (1000 steps, 400m) is NOT flagged', () => {
      const v = validateHealthPlausibility(snap({ steps: 1000, activity: { distanceM: 400 } }))
      expect(v.some((x) => x.rule === 'distance/steps coherence')).toBe(false)
    })

    it('[FN-catch] Rule 2 <3000 branch: ratio=0.399 (1000 steps, 399m) IS flagged', () => {
      const v = validateHealthPlausibility(snap({ steps: 1000, activity: { distanceM: 399 } }))
      expect(v.some((x) => x.rule === 'distance/steps coherence')).toBe(true)
    })
  })

  // Rule 3: activity.distanceM vs sum(workouts.distanceM).
  // A day's total distance must be >= the sum of workout distances (workouts are a subset
  // of daily activity). A day total lower than the workout sum is physically impossible --
  // the DA C1 anchor: 456m total < 1149m workout sum (live data, 2026-08-25).
  describe('Rule 3: activity distance vs workout sum coherence', () => {
    it('flags activity.distanceM < sum(workouts.distanceM) (physically impossible)', () => {
      const v = validateHealthPlausibility(snap({
        activity: { distanceM: 456 },
        workouts: [
          { type: 'walking', startAt: '2026-08-25T08:00:00Z', durationSec: 3600, distanceM: 800 },
          { type: 'running', startAt: '2026-08-25T17:00:00Z', durationSec: 1800, distanceM: 349 },
        ],
      }))
      expect(v.some((x) => x.rule === 'workout/activity distance coherence')).toBe(true)
      expect(hasSuspectViolation(v)).toBe(true)
    })

    it('does NOT flag when activity.distanceM >= sum(workouts.distanceM)', () => {
      const v = validateHealthPlausibility(snap({
        activity: { distanceM: 12040 },
        workouts: [
          { type: 'walking', startAt: '2026-08-25T08:00:00Z', durationSec: 3600, distanceM: 4000 },
          { type: 'running', startAt: '2026-08-25T17:00:00Z', durationSec: 1800, distanceM: 6000 },
        ],
      }))
      expect(v.some((x) => x.rule === 'workout/activity distance coherence')).toBe(false)
    })

    it('does NOT flag when workout distances are all absent (undefined)', () => {
      const v = validateHealthPlausibility(snap({
        activity: { distanceM: 456 },
        workouts: [
          { type: 'walking', startAt: '2026-08-25T08:00:00Z', durationSec: 3600 },
        ],
      }))
      expect(v.some((x) => x.rule === 'workout/activity distance coherence')).toBe(false)
    })

    it('does NOT flag when activity.distanceM is absent', () => {
      const v = validateHealthPlausibility(snap({
        activity: { activeKcal: 500 },
        workouts: [
          { type: 'running', startAt: '2026-08-25T08:00:00Z', durationSec: 3600, distanceM: 8000 },
        ],
      }))
      expect(v.some((x) => x.rule === 'workout/activity distance coherence')).toBe(false)
    })

    it('does NOT flag when there are no workouts', () => {
      const v = validateHealthPlausibility(snap({
        activity: { distanceM: 456 },
      }))
      expect(v.some((x) => x.rule === 'workout/activity distance coherence')).toBe(false)
    })

    it('[FP-catch] Rule 3: equal values (distanceM == sum) is NOT flagged (boundary)', () => {
      const v = validateHealthPlausibility(snap({
        activity: { distanceM: 5000 },
        workouts: [
          { type: 'running', startAt: '2026-08-25T08:00:00Z', durationSec: 3600, distanceM: 5000 },
        ],
      }))
      expect(v.some((x) => x.rule === 'workout/activity distance coherence')).toBe(false)
    })

    it('[FN-catch] Rule 3: 1m below sum IS flagged', () => {
      const v = validateHealthPlausibility(snap({
        activity: { distanceM: 4999 },
        workouts: [
          { type: 'running', startAt: '2026-08-25T08:00:00Z', durationSec: 3600, distanceM: 5000 },
        ],
      }))
      expect(v.some((x) => x.rule === 'workout/activity distance coherence')).toBe(true)
    })
  })
})
