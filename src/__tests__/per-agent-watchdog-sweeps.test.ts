import { describe, it, expect } from 'vitest'
import {
  runWatchdogSweeps,
  type WatchdogSweepDeps,
  type SweepResult,
  type HangSweepResult,
  type StaleSweepResult,
} from '../web/per-agent-pipe-watchdog.js'
import type { HangVerdict } from '../web/pipe-hang-detector.js'

// runWatchdogSweeps is the Part-1 activation seam: one watchdog tick runs the
// liveness sweep, the hang sweep AND the stale-health backstop -- the latter two
// regardless of dashboard state, each isolated so one failing never suppresses
// the others.

const skipUp: SweepResult = { skipped: true, reason: 'dashboard-up', results: {} }
const hangRes = (over: Partial<HangSweepResult> = {}): HangSweepResult => ({
  swept: [], recovered: [], results: {}, ...over,
})
const staleRes = (over: Partial<StaleSweepResult> = {}): StaleSweepResult => ({
  checked: [], probed: [], freshness: {}, results: {}, ...over,
})
const hung = (id: string): HangVerdict => ({ state: 'hung', hungForMs: 120_000, toolUseId: id })
const ok = (): HangVerdict => ({ state: 'ok', hungForMs: 0, toolUseId: 'x' })

function mk(over: Partial<WatchdogSweepDeps>): WatchdogSweepDeps {
  return { subSweep: async () => skipUp, hangSweep: () => hangRes(), staleSweep: async () => staleRes(), ...over }
}

describe('runWatchdogSweeps', () => {
  it('runs all sweeps; hang + stale run even when the liveness sweep is skipped', async () => {
    const lines = await runWatchdogSweeps(mk({}))
    expect(lines).toEqual([
      'sweep=skipped reason=dashboard-up',
      'hang=done swept=0 hung=0 recovered=0',
      'stale=done checked=0 probed=0 dead=0',
    ])
  })

  it('reports stale-sweep counts, including a live-confirmed dead pipe', async () => {
    const lines = await runWatchdogSweeps(mk({
      staleSweep: async () => staleRes({
        checked: ['a', 'b'],
        probed: ['b'],
        freshness: { a: 'fresh', b: 'stale' },
        results: { b: { verdict: 'dead', recovered: true, escalated: true } as unknown as StaleSweepResult['results'][string] },
      }),
    }))
    expect(lines[2]).toBe('stale=done checked=2 probed=1 dead=1')
  })

  it('a failing stale sweep still yields the other lines', async () => {
    const lines = await runWatchdogSweeps(mk({
      staleSweep: async () => { throw new Error('splat') },
    }))
    expect(lines[0]).toBe('sweep=skipped reason=dashboard-up')
    expect(lines[1]).toBe('hang=done swept=0 hung=0 recovered=0')
    expect(lines[2]).toBe('stale=error detail=splat')
  })

  it('formats per-agent liveness verdicts (dashboard-down sweep)', async () => {
    const results = { solo: { verdict: 'dead', recovered: false, escalated: true } }
    const swept = { skipped: false, reason: 'swept', results } as unknown as SweepResult
    const lines = await runWatchdogSweeps(mk({ subSweep: async () => swept }))
    expect(lines[0]).toBe('sweep=done agents=1 solo:dead+escalated')
  })

  it('reports hung and recovered counts from the hang sweep', async () => {
    const lines = await runWatchdogSweeps(mk({
      hangSweep: () => hangRes({ swept: ['a', 'b'], recovered: ['a'], results: { a: hung('t1'), b: ok() } }),
    }))
    expect(lines[1]).toBe('hang=done swept=2 hung=1 recovered=1')
  })

  it('a failing liveness sweep does not suppress the hang sweep', async () => {
    const lines = await runWatchdogSweeps(mk({
      subSweep: async () => { throw new Error('boom') },
      hangSweep: () => hangRes({ swept: ['a'], results: { a: ok() } }),
    }))
    expect(lines[0]).toBe('sweep=error detail=boom')
    expect(lines[1]).toBe('hang=done swept=1 hung=0 recovered=0')
  })

  it('a failing hang sweep still yields the liveness line', async () => {
    const lines = await runWatchdogSweeps(mk({
      hangSweep: () => { throw new Error('kaboom') },
    }))
    expect(lines[0]).toBe('sweep=skipped reason=dashboard-up')
    expect(lines[1]).toBe('hang=error detail=kaboom')
  })
})
