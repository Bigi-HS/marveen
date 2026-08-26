/**
 * Tests for GET /api/pipeline/reality-check -- pipeline reality gate (OPS-125, 85fb3009).
 */
import { describe, it, expect } from 'vitest'
import { decideRealityGate, DEFAULT_MAX_STALE_DAYS } from '../web/routes/pipeline-reality-gate.js'

function decide(over: {
  adherence?: { active: number; total: number }
  daysSinceLastHabit?: number | null
  maxStaleDays?: number
}) {
  return decideRealityGate({
    owner: 'hibiki',
    adherence: over.adherence ?? { active: 3, total: 7 },
    // Use !== undefined so explicit null passes through (null !== undefined)
    daysSinceLastHabit: over.daysSinceLastHabit !== undefined ? over.daysSinceLastHabit : 2,
    maxStaleDays: over.maxStaleDays ?? DEFAULT_MAX_STALE_DAYS,
  })
}

describe('decideRealityGate (pure)', () => {
  it('shouldProceed=true when adherence > 0 and habit recent', () => {
    const r = decide({ adherence: { active: 3, total: 7 }, daysSinceLastHabit: 2 })
    expect(r.shouldProceed).toBe(true)
  })

  it('shouldProceed=false when adherence=0 (no habit in 7 days)', () => {
    const r = decide({ adherence: { active: 0, total: 7 }, daysSinceLastHabit: 8 })
    expect(r.shouldProceed).toBe(false)
    expect(r.reason).toMatch(/adherence 0/)
  })

  it('shouldProceed=false when no habit ever logged (daysSinceLastHabit=null)', () => {
    const r = decide({ adherence: { active: 3, total: 7 }, daysSinceLastHabit: null })
    expect(r.shouldProceed).toBe(false)
    expect(r.reason).toMatch(/no habit ever/)
  })

  it('shouldProceed=false when last habit exceeds maxStaleDays', () => {
    const r = decide({ adherence: { active: 3, total: 7 }, daysSinceLastHabit: 15, maxStaleDays: 14 })
    expect(r.shouldProceed).toBe(false)
    expect(r.reason).toMatch(/stale threshold/)
  })

  it('shouldProceed=true at exactly maxStaleDays (boundary: not yet stale)', () => {
    const r = decide({ adherence: { active: 3, total: 7 }, daysSinceLastHabit: 14, maxStaleDays: 14 })
    expect(r.shouldProceed).toBe(true)
  })

  it('result includes all fields', () => {
    const r = decide({})
    expect(r).toHaveProperty('owner')
    expect(r).toHaveProperty('shouldProceed')
    expect(r).toHaveProperty('adherence')
    expect(r).toHaveProperty('daysSinceLastHabit')
    expect(r).toHaveProperty('maxStaleDays')
    expect(r).toHaveProperty('reason')
  })
})
