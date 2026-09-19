// WELL-027 AC-5/AC-6: per-field reliability tier + derived-metric min-tier inheritance.
// The 1800-vs-2811 structural fix: a derived Boss-facing number can never be MORE reliable
// than its weakest input, so a deficit computed off an UNAVAILABLE activeKcal is UNAVAILABLE.

import { describe, it, expect } from 'vitest'
import type { ZeppDailySnapshot } from '../web/zepp/contract.js'
import {
  minTier,
  compareTier,
  deriveFieldTiers,
  derivedMetricTier,
  applyReliabilityTiers,
  type ReliabilityTier,
} from '../web/zepp/reliability-tier.js'

function snap(partial: Partial<ZeppDailySnapshot>): ZeppDailySnapshot {
  return {
    date: '2026-08-25',
    pulledAt: '2026-08-25T06:00:00Z',
    status: 'ok',
    ...partial,
  }
}

describe('tier ordering + minTier (AC-6 weakest-wins)', () => {
  it('orders MEASURED > ADJUSTED > ESTIMATED > UNAVAILABLE', () => {
    expect(compareTier('MEASURED', 'ADJUSTED')).toBeGreaterThan(0)
    expect(compareTier('ADJUSTED', 'ESTIMATED')).toBeGreaterThan(0)
    expect(compareTier('ESTIMATED', 'UNAVAILABLE')).toBeGreaterThan(0)
    expect(compareTier('MEASURED', 'MEASURED')).toBe(0)
  })

  it('minTier returns the weakest input tier', () => {
    expect(minTier('MEASURED', 'ADJUSTED')).toBe('ADJUSTED')
    expect(minTier('MEASURED', 'ESTIMATED', 'ADJUSTED')).toBe('ESTIMATED')
    expect(minTier('MEASURED', 'UNAVAILABLE')).toBe('UNAVAILABLE')
    expect(minTier('MEASURED')).toBe('MEASURED')
  })

  it('minTier with no inputs is UNAVAILABLE (no basis to trust)', () => {
    expect(minTier()).toBe('UNAVAILABLE')
  })
})

describe('deriveFieldTiers (AC-5 provenance x plausibility)', () => {
  it('activeKcal undefined -> UNAVAILABLE (structural: Zepp/HC never writes it)', () => {
    const t = deriveFieldTiers(snap({ steps: 15790, activity: { distanceM: 12040 } }))
    expect(t.activeKcal).toBe('UNAVAILABLE')
  })

  it('activeKcal flagged suspect -> UNAVAILABLE (present but implausible)', () => {
    const t = deriveFieldTiers(
      snap({ steps: 15790, activity: { activeKcal: 5, activeKcalSuspect: true, distanceM: 12040 } }),
    )
    expect(t.activeKcal).toBe('UNAVAILABLE')
  })

  it('plausible measured activeKcal -> MEASURED', () => {
    const t = deriveFieldTiers(
      snap({ steps: 15790, activity: { activeKcal: 700, distanceM: 12040 } }),
    )
    expect(t.activeKcal).toBe('MEASURED')
  })

  it('distanceSource step_estimated -> ESTIMATED', () => {
    const t = deriveFieldTiers(
      snap({
        steps: 15790,
        activity: { distanceM: 456, distanceSource: 'step_estimated', estimatedDistanceM: 12034 },
      }),
    )
    expect(t.distance).toBe('ESTIMATED')
  })

  it('measured distance -> MEASURED; absent distance -> UNAVAILABLE', () => {
    expect(
      deriveFieldTiers(snap({ steps: 15790, activity: { distanceM: 12040, distanceSource: 'measured' } }))
        .distance,
    ).toBe('MEASURED')
    expect(deriveFieldTiers(snap({ steps: 15790, activity: {} })).distance).toBe('UNAVAILABLE')
  })

  it('steps present -> MEASURED; absent -> UNAVAILABLE', () => {
    expect(deriveFieldTiers(snap({ steps: 15790, activity: {} })).steps).toBe('MEASURED')
    expect(deriveFieldTiers(snap({ activity: {} })).steps).toBe('UNAVAILABLE')
  })
})

describe('derivedMetricTier (AC-6 min-tier inheritance)', () => {
  it('deficit off UNAVAILABLE activeKcal is UNAVAILABLE even when steps MEASURED', () => {
    // 1800-vs-2811 incident: target = 1800 + activeKcal. activeKcal UNAVAILABLE ->
    // the derived target can NOT be surfaced as a hard MEASURED number.
    const tiers = deriveFieldTiers(snap({ steps: 15790, activity: { distanceM: 12040 } }))
    const derived = derivedMetricTier([tiers.steps!, tiers.activeKcal!])
    expect(derived).toBe('UNAVAILABLE')
  })

  it('a derived metric can never exceed its weakest input', () => {
    expect(derivedMetricTier(['MEASURED', 'ESTIMATED'])).toBe('ESTIMATED')
    expect(derivedMetricTier(['ADJUSTED', 'MEASURED'])).toBe('ADJUSTED')
  })

  it('all-MEASURED inputs yield MEASURED', () => {
    expect(derivedMetricTier(['MEASURED', 'MEASURED'])).toBe('MEASURED')
  })
})

describe('applyReliabilityTiers (write-path attach, pure)', () => {
  it('attaches the per-field tier map without mutating the input', () => {
    const input = snap({ steps: 15790, activity: { activeKcal: 5, activeKcalSuspect: true, distanceM: 12040 } })
    const out = applyReliabilityTiers(input)
    expect(out.reliability).toEqual({
      steps: 'MEASURED',
      distance: 'MEASURED',
      activeKcal: 'UNAVAILABLE',
    })
    expect(input.reliability).toBeUndefined()
  })

  it('is idempotent: re-running yields the same map', () => {
    const input = snap({ steps: 15790, activity: { distanceM: 12040 } })
    const once = applyReliabilityTiers(input)
    const twice = applyReliabilityTiers(once)
    expect(twice.reliability).toEqual(once.reliability)
  })

  it('a snapshot with no activity still tiers steps', () => {
    const out = applyReliabilityTiers(snap({ steps: 8000 }))
    expect(out.reliability?.steps).toBe('MEASURED')
    expect(out.reliability?.activeKcal).toBe('UNAVAILABLE')
  })
})
