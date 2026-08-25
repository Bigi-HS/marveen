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
})
