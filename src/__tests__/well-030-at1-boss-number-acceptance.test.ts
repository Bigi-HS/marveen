// WELL-030 AT-1 -- Boss-number acceptance (card 44783957 P0 / AT-1).
//
// Normative source: docs/design/well-030-at1-boss-number-acceptance-dod.md (Black Bart, PM).
// This test pins the REAL incident record's input -> Boss-facing number chain with
// value-carrying, exact-equality assertions -- NOT synthetic shape. Every number is
// measured from the deployed code + the real landed record (store/zepp/daily-2026-08-25.json,
// verified 2026-08-26: steps=15790, distanceM=456, activeKcal=5, status=ok).
//
// Why AT-1 exists (and is distinct from distance-estimate.test.ts): the unit tests prove the
// estimator's individual branches with hand-built synthetic fields (e.g. activeKcal=500). AT-1
// is the acceptance pin grounded on the ACTUAL 2026-08-25 BUG-2 record -- one coherent
// input -> Boss-number chain (distance estimate + km display + kcal-detection boundary) so a
// regression in ANY link (stride constant, trigger threshold, selector, kcal detector) fails
// this one named test.
//
// Scope (DoD sec.6): layer 1 -- deterministic pin through the pure functions. Layer 2 (raw HC
// push through the ingest/transform path) is BLOCKED on the P0.5 raw-buffer and is NOT faked
// here: faking a raw push would re-inherit the synthetic-shape blindspot AT-1 exists to kill.

import { describe, it, expect } from 'vitest'
import { applyDistanceEstimate, distanceForDisplay } from '../web/zepp/distance-estimate.js'
import { validateHealthPlausibility, hasSuspectViolation } from '../web/zepp/health-plausibility.js'
import type { ZeppDailySnapshot } from '../web/zepp/contract.js'

// The real 2026-08-25 landed record (the incident that WELL-030 remediates). These are the
// exact measured field values from store/zepp/daily-2026-08-25.json -- pinned as a hermetic
// fixture (the store dir is gitignored, so we do not read it at test time), source-cited above.
const BOSS_DAY_2026_08_25: ZeppDailySnapshot = {
  date: '2026-08-25',
  pulledAt: '2026-08-25T06:00:00Z',
  status: 'ok',
  steps: 15790,
  activity: {
    distanceM: 456, // MEASURED, implausibly short -- BUG-2 upstream distance loss
    activeKcal: 5, // MEASURED, implausibly short -- same upstream loss
  },
}

describe('WELL-030 AT-1: real 2026-08-25 input -> Boss-facing number', () => {
  describe('distance: the Boss-facing number chain', () => {
    const finalized = applyDistanceEstimate(BOSS_DAY_2026_08_25)

    it('labels distanceSource step_estimated (15790 >= 1000 AND 456 < 15790*0.4=6316)', () => {
      expect(finalized.activity?.distanceSource).toBe('step_estimated')
    })

    it('sets estimatedDistanceM to EXACTLY 12032 = round(15790 * 0.762) -- NOT 12040', () => {
      // 12040 = round(15790 * 0.7625) is the calibration RATIO in the code comment; the
      // DEPLOYED constant is the rounded 0.762 -> 12032. Exact equality: a band would mask a
      // stride-constant drift, which is the class of silent regression AT-1 exists to catch.
      expect(finalized.activity?.estimatedDistanceM).toBe(12032)
    })

    it('leaves measured distanceM UNCHANGED at 456 (estimate sits alongside, never overwrites)', () => {
      expect(finalized.activity?.distanceM).toBe(456)
    })

    it('distanceForDisplay selects the estimate: { meters: 12032, source: step_estimated }', () => {
      expect(distanceForDisplay(finalized.activity)).toEqual({ meters: 12032, source: 'step_estimated' })
    })

    it('Boss display rounds to exactly 12 km, labelled as an estimate', () => {
      const shown = distanceForDisplay(finalized.activity)!
      expect(Math.round(shown.meters / 1000)).toBe(12)
      // The number is an estimate, so the Boss string must carry an estimate label (never
      // presented as a measured value -- absence-of-errors discipline).
      expect(shown.source).toBe('step_estimated')
    })

    it('is a pure read: the input record is not mutated', () => {
      expect(BOSS_DAY_2026_08_25.activity?.distanceSource).toBeUndefined()
      expect(BOSS_DAY_2026_08_25.activity?.estimatedDistanceM).toBeUndefined()
      expect(BOSS_DAY_2026_08_25.activity?.distanceM).toBe(456)
    })
  })

  describe('activeKcal: DETECTION only, no output number (scope boundary)', () => {
    const violations = validateHealthPlausibility(BOSS_DAY_2026_08_25)

    it('flags activeKcal=5 as suspect (implausible for 15790 steps, floor 15790*0.03=473)', () => {
      const kcalViolation = violations.find((v) => v.rule === 'activeKcal/steps ratio')
      expect(kcalViolation).toBeDefined()
      expect(kcalViolation!.severity).toBe('suspect')
      expect(hasSuspectViolation(violations)).toBe(true)
    })

    it('does NOT correct activeKcal to a number -- no kcal remediation exists (detection-only)', () => {
      // The distance remediation must not invent a kcal value; there is no producing code path
      // for a corrected activeKcal. Asserting the broken 5 survives proves AT-1 pins detection,
      // not a (non-existent) corrected-value output. Do NOT add a kcal output-number assertion
      // until a remediation exists -- it would be a value-independent (empty) assertion.
      const finalized = applyDistanceEstimate(BOSS_DAY_2026_08_25)
      expect(finalized.activity?.activeKcal).toBe(5)
      expect((finalized.activity as Record<string, unknown>).estimatedActiveKcal).toBeUndefined()
    })
  })
})
