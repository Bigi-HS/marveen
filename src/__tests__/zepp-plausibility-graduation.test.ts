// WELL-027 AC-2 (card 7888d628): graduation table + block-mode switch for the four
// log-only plausibility rules. Proves (i) the graduation table is fully populated for all
// four rules, (ii) the block-mode switch actually toggles in BOTH directions and per-rule
// (flipping one rule does not disturb the others), and (iii) the measurable FP-rate
// promotion criterion.

import { describe, it, expect } from 'vitest'
import type { ZeppDailySnapshot } from '../web/zepp/contract.js'
import {
  GRADUATION_TABLE,
  PLAUSIBILITY_RULE_IDS,
  effectiveMode,
  gatePlausibility,
  graduationPolicyFor,
  isReadyForBlockPromotion,
  measuredFpRate,
  ruleIdForViolation,
  type PlausibilityModeConfig,
  type PlausibilityRuleId,
} from '../web/zepp/plausibility-graduation.js'

function snap(over: Partial<ZeppDailySnapshot>): ZeppDailySnapshot {
  return { date: '2026-08-25', pulledAt: '2026-08-25T20:00:00.000Z', status: 'ok', ...over }
}

// A snapshot that trips exactly Rule 1 (activeKcal/steps) and NOT the others: high steps,
// absurdly low activeKcal, but a coherent distance and no workouts / vitals.
const kcalOnlySuspect = snap({
  steps: 15790,
  activity: { activeKcal: 5, distanceM: 12000 },
})

// A snapshot that trips exactly Rule 4 (heart-rate) and nothing else: no activity/steps.
const hrOnlySuspect = snap({
  vitals: { restingHr: 80, hrAvg: 70, hrMax: 120 }, // restingHr >= hrAvg -> suspect
})

describe('AC-2 graduation table', () => {
  it('has a fully-populated policy row for all four rules', () => {
    expect(GRADUATION_TABLE).toHaveLength(4)
    const ids = GRADUATION_TABLE.map((p) => p.ruleId).sort()
    expect(ids).toEqual([...PLAUSIBILITY_RULE_IDS].sort())

    for (const p of GRADUATION_TABLE) {
      // Each of the four required fields must be present + sane (owner + date filled).
      expect(p.fpThreshold).toBeGreaterThan(0)
      expect(p.fpThreshold).toBeLessThanOrEqual(1)
      expect(p.windowDays).toBeGreaterThan(0)
      expect(p.owner).toBeTruthy()
      expect(typeof p.owner).toBe('string')
      expect(p.revisitDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('ships every rule LOG-ONLY (no rule blind-flipped before its data window)', () => {
    for (const p of GRADUATION_TABLE) {
      expect(p.mode).toBe('log-only')
    }
    // The default effective mode (no override config) is therefore log-only for every rule.
    for (const id of PLAUSIBILITY_RULE_IDS) {
      expect(effectiveMode(id)).toBe('log-only')
    }
  })
})

describe('rule-id classification', () => {
  it('maps each live rule string to its stable rule id', () => {
    const cases: Array<[string, PlausibilityRuleId]> = [
      ['activeKcal/steps ratio', 'activeKcal-steps'],
      ['distance/steps coherence', 'distance-steps'],
      ['workout/activity distance coherence', 'workout-distance'],
      ['heart rate ordering', 'heart-rate'],
      ['heart rate reserve', 'heart-rate'],
      ['heart rate bounds', 'heart-rate'],
      ['heart rate flatness', 'heart-rate'],
    ]
    for (const [rule, id] of cases) {
      expect(ruleIdForViolation({ rule, severity: 'suspect', message: '' })).toBe(id)
    }
  })

  it('returns undefined for an unrecognised rule string', () => {
    expect(ruleIdForViolation({ rule: 'nonsense rule', severity: 'suspect', message: '' })).toBeUndefined()
  })
})

describe('AC-2 block-mode switch (the core acceptance)', () => {
  it('log-only by default: a suspect snapshot is NOT blocked', () => {
    const d = gatePlausibility(kcalOnlySuspect)
    expect(d.blocked).toBe(false)
    // The suspect verdict is still surfaced -- just as a non-blocking log-only entry.
    expect(d.logOnly.some((g) => g.ruleId === 'activeKcal-steps')).toBe(true)
    expect(d.blocking).toHaveLength(0)
  })

  it('FORWARD flip (log-only -> block): the flipped rule now BLOCKS its suspect', () => {
    const config: PlausibilityModeConfig = { 'activeKcal-steps': 'block' }
    const d = gatePlausibility(kcalOnlySuspect, config)
    expect(d.blocked).toBe(true)
    expect(d.blocking.map((g) => g.ruleId)).toContain('activeKcal-steps')
    expect(d.blocking[0].mode).toBe('block')
    // Nothing left in the log-only bucket for that rule -- it graduated to blocking.
    expect(d.logOnly.some((g) => g.ruleId === 'activeKcal-steps')).toBe(false)
  })

  it('REVERSE flip (block -> log-only): the same rule stops blocking again', () => {
    const blocked = gatePlausibility(kcalOnlySuspect, { 'activeKcal-steps': 'block' })
    expect(blocked.blocked).toBe(true)

    const reverted = gatePlausibility(kcalOnlySuspect, { 'activeKcal-steps': 'log-only' })
    expect(reverted.blocked).toBe(false)
    expect(reverted.logOnly.some((g) => g.ruleId === 'activeKcal-steps')).toBe(true)
    expect(reverted.blocking).toHaveLength(0)
  })

  it('per-rule isolation: flipping ONE rule leaves the others log-only', () => {
    // Flip only the heart-rate rule to block.
    const config: PlausibilityModeConfig = { 'heart-rate': 'block' }

    // A kcal-only suspect must NOT block (its rule was not flipped).
    const kcal = gatePlausibility(kcalOnlySuspect, config)
    expect(kcal.blocked).toBe(false)

    // An HR-only suspect MUST block (its rule was flipped).
    const hr = gatePlausibility(hrOnlySuspect, config)
    expect(hr.blocked).toBe(true)
    expect(hr.blocking.map((g) => g.ruleId)).toContain('heart-rate')

    // The other three rules stay log-only under this config.
    for (const id of PLAUSIBILITY_RULE_IDS) {
      expect(effectiveMode(id, config)).toBe(id === 'heart-rate' ? 'block' : 'log-only')
    }
  })

  it('a clean snapshot is never blocked, regardless of mode config', () => {
    const clean = snap({ steps: 10000, activity: { activeKcal: 500, distanceM: 7000 } })
    const allBlock: PlausibilityModeConfig = {
      'activeKcal-steps': 'block',
      'distance-steps': 'block',
      'workout-distance': 'block',
      'heart-rate': 'block',
    }
    const d = gatePlausibility(clean, allBlock)
    expect(d.blocked).toBe(false)
    expect(d.blocking).toHaveLength(0)
    expect(d.logOnly).toHaveLength(0)
  })

  it('only suspect severity gates: a warning-only snapshot never blocks even in block mode', () => {
    // hrMax - hrAvg = 10 (<15) -> a 'warning' reserve violation, but ordering is valid so no
    // suspect. In full block mode this must still not block.
    const warnOnly = snap({ vitals: { restingHr: 55, hrAvg: 100, hrMax: 110 } })
    const d = gatePlausibility(warnOnly, { 'heart-rate': 'block' })
    expect(d.blocked).toBe(false)
  })
})

describe('AC-2 measurable promotion criterion (FP-rate from anomaly-store history)', () => {
  it('measuredFpRate = falsePositives / episodes; undefined with no episodes', () => {
    expect(measuredFpRate({ ruleId: 'activeKcal-steps', episodes: 0, falsePositives: 0 })).toBeUndefined()
    expect(measuredFpRate({ ruleId: 'activeKcal-steps', episodes: 10, falsePositives: 1 })).toBeCloseTo(0.1)
  })

  it('NOT ready to promote with zero data (the honest fresh-log-only state)', () => {
    expect(isReadyForBlockPromotion({ ruleId: 'activeKcal-steps', episodes: 0, falsePositives: 0 })).toBe(false)
  })

  it('ready when the measured FP rate is at/below the policy threshold', () => {
    const policy = graduationPolicyFor('activeKcal-steps')!
    // Exactly at threshold (5% of 20 = 1 FP) -> ready.
    expect(
      isReadyForBlockPromotion({ ruleId: 'activeKcal-steps', episodes: 20, falsePositives: 1 }),
    ).toBe(true)
    expect(policy.fpThreshold).toBe(0.05)
  })

  it('NOT ready when the measured FP rate exceeds the policy threshold', () => {
    // 2 FP in 20 episodes = 10% > 5% threshold.
    expect(
      isReadyForBlockPromotion({ ruleId: 'activeKcal-steps', episodes: 20, falsePositives: 2 }),
    ).toBe(false)
  })

  it('respects a per-rule threshold (workout-distance tolerates a higher FP bar)', () => {
    // workout-distance threshold is 0.1: 2 FP in 20 = 10% is at threshold -> ready.
    expect(
      isReadyForBlockPromotion({ ruleId: 'workout-distance', episodes: 20, falsePositives: 2 }),
    ).toBe(true)
  })
})
