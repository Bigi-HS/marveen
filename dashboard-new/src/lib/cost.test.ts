import { describe, it, expect } from 'vitest'
import {
  agentTotalTokens,
  totalCostUsd,
  sortByCost,
  cacheHitRatio,
  formatUsd,
  formatTokens,
} from './cost'
import type { CostAgent } from '@/types/cost'

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
})
