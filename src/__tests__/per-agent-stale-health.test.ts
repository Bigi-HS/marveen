import { describe, it, expect } from 'vitest'
import {
  runStaleHealthSweep,
  type StaleSweepDeps,
} from '../web/per-agent-pipe-watchdog.js'
import type { WatchdogState } from '../web/telegram-pipe-watchdog.js'
import type { CycleResult } from '../web/telegram-pipe-watchdog.js'

const NOW = 1_700_000_000_000
const STALE_AFTER = 15 * 60 * 1000

const healthyCycle: CycleResult = {
  verdict: 'healthy',
  recovered: false,
  escalated: false,
  state: { consecutiveDead: 0, alerted: false, lastHealthyTs: NOW, lastCheckedTs: NOW },
}
const deadCycle: CycleResult = {
  verdict: 'dead',
  recovered: true,
  escalated: true,
  state: { consecutiveDead: 2, alerted: true, lastHealthyTs: null, lastCheckedTs: NOW },
}

function mk(states: Record<string, WatchdogState>, over: Partial<StaleSweepDeps> = {}): {
  deps: StaleSweepDeps
  probed: string[]
} {
  const probed: string[] = []
  const deps: StaleSweepDeps = {
    listChannelSubAgents: () => Object.keys(states),
    readAgentState: (name) => states[name],
    runAgentCycle: async (name) => {
      probed.push(name)
      return healthyCycle
    },
    staleAfterMs: STALE_AFTER,
    ...over,
  }
  return { deps, probed }
}

const fresh = (): WatchdogState => ({
  consecutiveDead: 0, alerted: false, lastHealthyTs: NOW - 1_000, lastCheckedTs: NOW - 60_000,
})
const stale = (): WatchdogState => ({
  consecutiveDead: 0, alerted: false, lastHealthyTs: null, lastCheckedTs: NOW - 18 * 60 * 60 * 1000,
})
const never = (): WatchdogState => ({
  consecutiveDead: 0, alerted: false, lastHealthyTs: null, lastCheckedTs: null,
})

describe('runStaleHealthSweep', () => {
  it('a fresh state is trusted -- no live probe', async () => {
    const { deps, probed } = mk({ a: fresh() })
    const res = await runStaleHealthSweep(NOW, deps)
    expect(probed).toEqual([])
    expect(res.checked).toEqual(['a'])
    expect(res.probed).toEqual([])
    expect(res.freshness.a).toBe('fresh')
  })

  // The hibiki regression: a stale "consecutiveDead=0" must trigger a REAL
  // probe, never be believed as healthy.
  it('ADVERSARIAL: a stale zero-dead state triggers a live probe', async () => {
    const { deps, probed } = mk({ hibiki: stale() })
    const res = await runStaleHealthSweep(NOW, deps)
    expect(probed).toEqual(['hibiki'])
    expect(res.probed).toEqual(['hibiki'])
    expect(res.freshness.hibiki).toBe('stale')
  })

  it('a never-checked state triggers a live probe', async () => {
    const { deps, probed } = mk({ fresh_agent: never() })
    await runStaleHealthSweep(NOW, deps)
    expect(probed).toEqual(['fresh_agent'])
  })

  it('surfaces a live-confirmed dead pipe in results', async () => {
    const { deps } = mk({ x: stale() }, { runAgentCycle: async () => deadCycle })
    const res = await runStaleHealthSweep(NOW, deps)
    expect(res.results.x.verdict).toBe('dead')
    expect(res.results.x.escalated).toBe(true)
  })

  it('probes only the stale agents in a mixed fleet', async () => {
    const { deps, probed } = mk({ a: fresh(), b: stale(), c: fresh(), d: never() })
    const res = await runStaleHealthSweep(NOW, deps)
    expect(probed.sort()).toEqual(['b', 'd'])
    expect(res.checked.sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(res.freshness).toEqual({ a: 'fresh', b: 'stale', c: 'fresh', d: 'never-checked' })
  })

  it('a single agent probe error does not abort the sweep', async () => {
    let calls = 0
    const { deps } = mk({ boom: stale(), ok: stale() }, {
      runAgentCycle: async (name) => {
        calls++
        if (name === 'boom') throw new Error('probe failed')
        return healthyCycle
      },
    })
    const res = await runStaleHealthSweep(NOW, deps)
    expect(calls).toBe(2)
    expect(res.results.ok.verdict).toBe('healthy')
    expect(res.results.boom).toBeUndefined()
  })

  it('an empty fleet is a clean no-op', async () => {
    const { deps } = mk({})
    const res = await runStaleHealthSweep(NOW, deps)
    expect(res).toEqual({ checked: [], probed: [], freshness: {}, results: {} })
  })
})
