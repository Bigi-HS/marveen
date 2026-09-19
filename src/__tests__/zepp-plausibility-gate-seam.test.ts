// WELL-027 AC-1/AC-2 SEAM (card d0694d6a): the block-mode switch output actually wired to a
// mark the consumer acts on, end-to-end. Two properties:
//   1. applyPlausibilityGate turns a block-mode suspect violation into a plausibilityBlocked
//      mark on the snapshot, and the switch-flip visibly changes that output (block vs log-only).
//   2. DRIFT-GUARD: every suspect violation the REAL validateHealthPlausibility emits maps to a
//      DEFINED rule id, so a rename of a rule string cannot silently fail-open (block-mode would
//      stop gating without a test failure). Rules 2 (distance-steps) and 3 (workout-distance) are
//      exercised through the real validator here, not via hardcoded strings.

import { describe, it, expect } from 'vitest'
import type { ZeppDailySnapshot } from '../web/zepp/contract.js'
import { validateHealthPlausibility } from '../web/zepp/health-plausibility.js'
import {
  applyPlausibilityGate,
  gatePlausibility,
  ruleIdForViolation,
  PLAUSIBILITY_RULE_IDS,
  type PlausibilityModeConfig,
} from '../web/zepp/plausibility-graduation.js'

function snap(over: Partial<ZeppDailySnapshot>): ZeppDailySnapshot {
  return { date: '2026-08-25', pulledAt: '2026-08-25T20:00:00.000Z', status: 'ok', ...over }
}

// --- Real violating fixtures, one per rule, through validateHealthPlausibility ------------------
// Rule 1: activeKcal 5 at 15,790 steps (live 2026-08-25 loss).
const KCAL_VIOLATION = snap({ steps: 15790, activity: { activeKcal: 5, distanceM: 12040 } })
// Rule 2: distance 456m at 15,790 steps (live 2026-08-25 loss).
const DISTANCE_VIOLATION = snap({ steps: 15790, activity: { activeKcal: 700, distanceM: 456 } })
// Rule 3: day distance < workout sum (physically impossible).
const WORKOUT_VIOLATION = snap({
  steps: 15790,
  activity: { activeKcal: 700, distanceM: 456 },
  workouts: [{ type: 'running', startAt: '2026-08-25T05:00:00Z', durationSec: 3600, distanceM: 1149 }],
})
// Rule 4: pathologically low restingHr.
const HR_VIOLATION = snap({ vitals: { restingHr: 30, hrAvg: 60, hrMax: 150 } })

describe('applyPlausibilityGate seam: block-mode mark is wired end-to-end (AC-1/AC-2)', () => {
  it('default (all log-only): a suspect snapshot is NOT marked blocked -- todays behaviour', () => {
    const gated = applyPlausibilityGate(DISTANCE_VIOLATION)
    expect(gated.plausibilityBlocked).toBeUndefined()
    expect(gated.blockedRuleIds).toBeUndefined()
  })

  it('flip distance-steps to block: the SAME suspect snapshot is now marked blocked', () => {
    const config: PlausibilityModeConfig = { 'distance-steps': 'block' }
    const gated = applyPlausibilityGate(DISTANCE_VIOLATION, config)
    expect(gated.plausibilityBlocked).toBe(true)
    expect(gated.blockedRuleIds).toEqual(['distance-steps'])
  })

  it('the switch-flip visibly changes the gate output for the identical input', () => {
    const logOnly = applyPlausibilityGate(DISTANCE_VIOLATION)
    const blocked = applyPlausibilityGate(DISTANCE_VIOLATION, { 'distance-steps': 'block' })
    expect(logOnly.plausibilityBlocked).toBeUndefined()
    expect(blocked.plausibilityBlocked).toBe(true)
  })

  it('per-rule isolation: flipping distance-steps does NOT block a kcal-only violation', () => {
    const gated = applyPlausibilityGate(KCAL_VIOLATION, { 'distance-steps': 'block' })
    expect(gated.plausibilityBlocked).toBeUndefined()
  })

  it('a clean snapshot is never blocked, even with every rule in block mode', () => {
    const clean = snap({ steps: 12000, activity: { activeKcal: 700, distanceM: 8000 } })
    const allBlock: PlausibilityModeConfig = Object.fromEntries(
      PLAUSIBILITY_RULE_IDS.map((id) => [id, 'block']),
    )
    const gated = applyPlausibilityGate(clean, allBlock)
    expect(gated.plausibilityBlocked).toBeUndefined()
  })

  it('is pure + idempotent and self-corrects a stale block flag', () => {
    const config: PlausibilityModeConfig = { 'distance-steps': 'block' }
    const once = applyPlausibilityGate(DISTANCE_VIOLATION, config)
    const twice = applyPlausibilityGate(once, config)
    expect(twice).toEqual(once)
    // input never mutated
    expect((DISTANCE_VIOLATION as ZeppDailySnapshot).plausibilityBlocked).toBeUndefined()
    // re-running the now-blocked snapshot in log-only mode drops the stale flag
    const cleared = applyPlausibilityGate(once)
    expect(cleared.plausibilityBlocked).toBeUndefined()
    expect(cleared.blockedRuleIds).toBeUndefined()
  })

  it('block on multiple rules lists every blocking rule id (deduped)', () => {
    const both = applyPlausibilityGate(DISTANCE_VIOLATION, {
      'distance-steps': 'block',
      'activeKcal-steps': 'block',
    })
    // DISTANCE_VIOLATION only violates distance-steps, so only that id appears.
    expect(both.blockedRuleIds).toEqual(['distance-steps'])
  })
})

describe('DRIFT-GUARD: every real suspect violation maps to a defined rule id (no silent fail-open)', () => {
  const fixtures: Array<{ name: string; snap: ZeppDailySnapshot; expectRuleId: string }> = [
    { name: 'Rule 1 activeKcal/steps', snap: KCAL_VIOLATION, expectRuleId: 'activeKcal-steps' },
    { name: 'Rule 2 distance/steps', snap: DISTANCE_VIOLATION, expectRuleId: 'distance-steps' },
    { name: 'Rule 3 workout/activity distance', snap: WORKOUT_VIOLATION, expectRuleId: 'workout-distance' },
    { name: 'Rule 4 heart-rate', snap: HR_VIOLATION, expectRuleId: 'heart-rate' },
  ]

  for (const f of fixtures) {
    it(`${f.name}: emits a suspect that classifies to ${f.expectRuleId}`, () => {
      const suspects = validateHealthPlausibility(f.snap).filter((v) => v.severity === 'suspect')
      expect(suspects.length).toBeGreaterThan(0)
      // No suspect from the real validator may be unclassifiable -- an undefined here is the
      // silent fail-open the card warns about (a renamed rule string that block-mode can no
      // longer gate on).
      for (const v of suspects) {
        expect(ruleIdForViolation(v)).toBeDefined()
      }
      expect(suspects.map((v) => ruleIdForViolation(v))).toContain(f.expectRuleId)
    })
  }

  it('Rule 2 + Rule 3 gate end-to-end in block mode (not just via hardcoded strings)', () => {
    // These two rules were previously covered only by hardcoded-string unit tests. Prove the
    // real validator -> ruleId -> block-mode path actually blocks for each.
    const d = gatePlausibility(DISTANCE_VIOLATION, { 'distance-steps': 'block' })
    expect(d.blocked).toBe(true)
    expect(d.blocking.map((g) => g.ruleId)).toContain('distance-steps')

    const w = gatePlausibility(WORKOUT_VIOLATION, { 'workout-distance': 'block' })
    expect(w.blocked).toBe(true)
    expect(w.blocking.map((g) => g.ruleId)).toContain('workout-distance')
  })
})
