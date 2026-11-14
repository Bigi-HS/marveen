import { describe, it, expect } from 'vitest'
import {
  agentTotalTokens,
  totalCostUsd,
  sortByCost,
  cacheHitRatio,
  formatUsd,
  formatTokens,
  spendRatePerHour,
  totalsByBucket,
} from './cost'
import type { CostAgent, TimelineBucket } from '@/types/cost'

function agent(over: Partial<CostAgent> = {}): CostAgent {
  return {
    agent: 'dave',
    totalCalls: 10,
    totalInput: 1000,
    totalOutput: 500,
    totalCacheRead: 4000,
    totalCacheCreation: 200,
    firstSeen: 1_700_000_000,
    lastSeen: 1_700_000_100,
    totalCostUsd: 1.5,
    ...over,
  }
}

describe('cost helpers (card e230c097)', () => {
  it('agentTotalTokens sums all four components', () => {
    expect(agentTotalTokens(agent())).toBe(1000 + 500 + 4000 + 200)
  })

  it('totalCostUsd sums every agent', () => {
    expect(totalCostUsd([agent({ totalCostUsd: 1.5 }), agent({ totalCostUsd: 2.25 })])).toBeCloseTo(3.75)
    expect(totalCostUsd([])).toBe(0)
  })

  it('sortByCost orders by spend desc, stable by name on ties', () => {
    const out = sortByCost([
      agent({ agent: 'chad', totalCostUsd: 1 }),
      agent({ agent: 'thor', totalCostUsd: 5 }),
      agent({ agent: 'bond', totalCostUsd: 1 }),
    ])
    expect(out.map((a) => a.agent)).toEqual(['thor', 'bond', 'chad'])
  })

  it('sortByCost does not mutate the input', () => {
    const input = [agent({ agent: 'a', totalCostUsd: 1 }), agent({ agent: 'b', totalCostUsd: 2 })]
    const before = input.map((a) => a.agent)
    sortByCost(input)
    expect(input.map((a) => a.agent)).toEqual(before)
  })

  it('cacheHitRatio = cacheRead / (input + cacheRead), 0 when no input-side traffic', () => {
    expect(cacheHitRatio(agent({ totalInput: 1000, totalCacheRead: 4000 }))).toBeCloseTo(0.8)
    expect(cacheHitRatio(agent({ totalInput: 0, totalCacheRead: 0 }))).toBe(0)
  })

  it('formatUsd is compact across magnitudes', () => {
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(1.5)).toBe('$1.50')
    expect(formatUsd(99.99)).toBe('$99.99')
    expect(formatUsd(1234)).toBe('$1,234')
    expect(formatUsd(25_000)).toBe('$25.0k')
    expect(formatUsd(NaN)).toBe('$0.00')
  })

  it('formatTokens is compact across magnitudes', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1500)).toBe('1.5k')
    expect(formatTokens(2_300_000)).toBe('2.3M')
  })

  it('spendRatePerHour = cost over the active window in hours', () => {
    // $6 over a 2-hour window -> $3/h.
    expect(
      spendRatePerHour(agent({ totalCostUsd: 6, firstSeen: 1_700_000_000, lastSeen: 1_700_007_200 })),
    ).toBeCloseTo(3)
  })

  it('spendRatePerHour clamps a sub-minute window to 60s (no divide-by-zero)', () => {
    // Single-sample window (firstSeen == lastSeen): denominator floored to 60s,
    // so a $1.50 burst reads as an instantaneous-style high rate, not Infinity/NaN.
    const r = spendRatePerHour(agent({ totalCostUsd: 1.5, firstSeen: 1_700_000_000, lastSeen: 1_700_000_000 }))
    expect(Number.isFinite(r)).toBe(true)
    expect(r).toBeCloseTo(1.5 / (60 / 3600)) // $90/h
  })
})

describe('totalsByBucket (card e230c097 slice 2)', () => {
  function tb(over: Partial<TimelineBucket> = {}): TimelineBucket {
    return { bucket: 1_700_000_000, agent: 'dave', calls: 1, inputTokens: 100, outputTokens: 50, costUsd: 1, ...over }
  }

  it('sums every agent into one row per time bucket, ascending by bucket', () => {
    const out = totalsByBucket([
      tb({ bucket: 200, agent: 'dave', calls: 2, inputTokens: 100, outputTokens: 20, costUsd: 3 }),
      tb({ bucket: 100, agent: 'thor', calls: 1, inputTokens: 40, outputTokens: 10, costUsd: 1 }),
      tb({ bucket: 100, agent: 'dave', calls: 3, inputTokens: 60, outputTokens: 30, costUsd: 2 }),
    ])
    expect(out.map((t) => t.bucket)).toEqual([100, 200])
    expect(out[0]).toEqual({ bucket: 100, calls: 4, tokens: 140, costUsd: 3 }) // thor+dave @100
    expect(out[1]).toEqual({ bucket: 200, calls: 2, tokens: 120, costUsd: 3 })
  })

  it('returns an empty array for no buckets', () => {
    expect(totalsByBucket([])).toEqual([])
  })
})
