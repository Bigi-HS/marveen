import { describe, it, expect, vi } from 'vitest'
import { runSubAgentSweep, type SweepDeps } from '../web/per-agent-pipe-watchdog.js'
import type { CycleResult } from '../web/telegram-pipe-watchdog.js'

const NOW = 1_700_000_000_000

function healthy(): CycleResult {
  return { verdict: 'healthy', recovered: false, escalated: false, state: { consecutiveDead: 0, alerted: false, lastHealthyTs: NOW } }
}
function deadRecovered(): CycleResult {
  return { verdict: 'dead', recovered: true, escalated: false, state: { consecutiveDead: 1, alerted: false, lastHealthyTs: null } }
}

describe('runSubAgentSweep -- dashboard-down gating', () => {
  it('SKIPS entirely when the dashboard is UP (in-process monitor owns recovery)', async () => {
    const runAgentCycle = vi.fn(async () => healthy())
    const deps: SweepDeps = {
      isDashboardUp: async () => true,
      listChannelSubAgents: () => ['thor', 'chad'],
      runAgentCycle,
    }
    const res = await runSubAgentSweep(NOW, deps)
    expect(res.skipped).toBe(true)
    expect(res.reason).toBe('dashboard-up')
    expect(res.results).toEqual({})
    // The critical anti-double-reconnect invariant: NO agent cycle runs while up.
    expect(runAgentCycle).not.toHaveBeenCalled()
  })

  it('skips (no-op) when the dashboard is down but there are no channel sub-agents', async () => {
    const runAgentCycle = vi.fn(async () => healthy())
    const deps: SweepDeps = {
      isDashboardUp: async () => false,
      listChannelSubAgents: () => [],
      runAgentCycle,
    }
    const res = await runSubAgentSweep(NOW, deps)
    expect(res.skipped).toBe(true)
    expect(res.reason).toBe('no-channel-agents')
    expect(runAgentCycle).not.toHaveBeenCalled()
  })

  it('sweeps EVERY channel sub-agent when the dashboard is DOWN', async () => {
    const seen: string[] = []
    const deps: SweepDeps = {
      isDashboardUp: async () => false,
      listChannelSubAgents: () => ['thor', 'chad', 'forge'],
      runAgentCycle: async (name, now) => {
        expect(now).toBe(NOW)
        seen.push(name)
        return name === 'chad' ? deadRecovered() : healthy()
      },
    }
    const res = await runSubAgentSweep(NOW, deps)
    expect(res.skipped).toBe(false)
    expect(res.reason).toBe('swept')
    expect(seen).toEqual(['thor', 'chad', 'forge'])
    expect(res.results.chad.recovered).toBe(true)
    expect(res.results.thor.verdict).toBe('healthy')
  })

  it('one agent throwing does NOT abort the rest of the sweep', async () => {
    const deps: SweepDeps = {
      isDashboardUp: async () => false,
      listChannelSubAgents: () => ['thor', 'chad', 'forge'],
      runAgentCycle: async name => {
        if (name === 'chad') throw new Error('tmux gone')
        return healthy()
      },
    }
    const res = await runSubAgentSweep(NOW, deps)
    expect(res.skipped).toBe(false)
    // thor + forge still recorded; chad dropped (no crash).
    expect(Object.keys(res.results).sort()).toEqual(['forge', 'thor'])
  })
})
