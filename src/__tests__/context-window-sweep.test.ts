import { describe, it, expect, vi } from 'vitest'
import {
  runContextSweep,
  formatAlert,
  type ContextSweepDeps,
  type ContextUsage,
  type ContextWatchState,
} from '../web/context-window-watchdog.js'
import { contextPercentForModel } from '../web/agent-config.js'

const NOW = 1_700_000_000_000

const usage = (percent: number, model: string | null = 'claude-sonnet-4-6'): ContextUsage => ({
  percent,
  tokens: percent * 2000,
  windowSize: 200_000,
  model,
})

// Deps with an in-memory persisted state so the dedup/hysteresis logic can be
// exercised across multiple cycles using the SAME deps object.
function makeDeps(over: Partial<ContextSweepDeps> = {}): ContextSweepDeps {
  let store: Record<string, ContextWatchState> = {}
  return {
    listAgents: () => ['a'],
    readUsage: () => null,
    sendAlert: async () => true,
    readState: () => store,
    writeState: (s) => { store = s },
    alertThreshold: 80,
    rearmThreshold: 70,
    ...over,
  }
}

describe('runContextSweep', () => {
  it('alerts when an agent crosses the threshold', async () => {
    const sendAlert = vi.fn(async () => true)
    const r = await runContextSweep(NOW, makeDeps({ readUsage: () => usage(84), sendAlert }))
    expect(sendAlert).toHaveBeenCalledTimes(1)
    expect(r.high).toEqual(['a'])
    expect(r.alerted).toEqual(['a'])
    expect(r.results.a).toBe(84)
  })

  it('does NOT re-alert on the next cycle while the agent stays high', async () => {
    const sendAlert = vi.fn(async () => true)
    const deps = makeDeps({ readUsage: () => usage(88), sendAlert })
    await runContextSweep(NOW, deps)
    await runContextSweep(NOW + 5000, deps) // still high, same crossing
    expect(sendAlert).toHaveBeenCalledTimes(1)
  })

  it('re-arms after dropping below the rearm line and alerts again on a new crossing', async () => {
    const sendAlert = vi.fn(async () => true)
    let pct = 90
    const deps = makeDeps({ readUsage: () => usage(pct), sendAlert })
    await runContextSweep(NOW, deps) // 90 -> alert 1
    pct = 65
    await runContextSweep(NOW + 5000, deps) // below rearm (70) -> re-armed, no alert
    pct = 92
    await runContextSweep(NOW + 10000, deps) // crosses again -> alert 2
    expect(sendAlert).toHaveBeenCalledTimes(2)
  })

  it('stays armed (no re-alert) while hovering in the hysteresis band', async () => {
    const sendAlert = vi.fn(async () => true)
    let pct = 85
    const deps = makeDeps({ readUsage: () => usage(pct), sendAlert })
    await runContextSweep(NOW, deps) // alert
    pct = 75 // between rearm(70) and alert(80) -> still armed, no re-arm
    await runContextSweep(NOW + 5000, deps)
    pct = 82 // back over threshold but never re-armed -> no new alert
    await runContextSweep(NOW + 10000, deps)
    expect(sendAlert).toHaveBeenCalledTimes(1)
  })

  it('takes no action when every agent is under the threshold', async () => {
    const sendAlert = vi.fn(async () => true)
    const r = await runContextSweep(NOW, makeDeps({ readUsage: () => usage(40), sendAlert }))
    expect(sendAlert).not.toHaveBeenCalled()
    expect(r.high).toEqual([])
    expect(r.alerted).toEqual([])
  })

  it('consolidates multiple crossed agents into ONE alert', async () => {
    const sendAlert = vi.fn(async () => true)
    const r = await runContextSweep(NOW, makeDeps({
      listAgents: () => ['a', 'b', 'c'],
      readUsage: (n) => (n === 'c' ? usage(30) : usage(95)),
      sendAlert,
    }))
    expect(sendAlert).toHaveBeenCalledTimes(1)
    expect(r.alerted.sort()).toEqual(['a', 'b'])
    expect(r.high.sort()).toEqual(['a', 'b'])
  })

  it('leaves an agent un-alerted when the send fails, and retries next cycle', async () => {
    const sendAlert = vi.fn(async () => false) // send fails
    const deps = makeDeps({ readUsage: () => usage(90), sendAlert })
    const r1 = await runContextSweep(NOW, deps)
    expect(r1.alerted).toEqual([]) // not marked alerted on failure
    const r2 = await runContextSweep(NOW + 5000, deps)
    expect(sendAlert).toHaveBeenCalledTimes(2) // retried, not swallowed
    expect(r2.high).toEqual(['a'])
  })

  it('skips an agent whose usage read throws without aborting the sweep', async () => {
    const sendAlert = vi.fn(async () => true)
    const r = await runContextSweep(NOW, makeDeps({
      listAgents: () => ['boom', 'ok'],
      readUsage: (n) => { if (n === 'boom') throw new Error('read fail'); return usage(95) },
      sendAlert,
    }))
    expect(r.swept).toEqual(['boom', 'ok'])
    expect(r.alerted).toEqual(['ok'])
    expect(sendAlert).toHaveBeenCalledTimes(1)
  })

  it('ignores agents with no reading (null usage)', async () => {
    const sendAlert = vi.fn(async () => true)
    const r = await runContextSweep(NOW, makeDeps({ listAgents: () => ['idle'], readUsage: () => null, sendAlert }))
    expect(r.results).toEqual({})
    expect(r.high).toEqual([])
    expect(sendAlert).not.toHaveBeenCalled()
  })
})

describe('formatAlert', () => {
  // Inject an identity resolver so the render assertion stays hermetic (does not
  // depend on the live agents/<name>/agent-config.json display names).
  it('renders one line per crossed agent with %, tokens and model', () => {
    const text = formatAlert([{ name: 'dave', usage: usage(99, 'claude-opus-4-8[1m]') }], (n) => n)
    expect(text).toContain('dave: 99%')
    expect(text).toContain('claude-opus-4-8[1m]')
    expect(text).toContain('98%') // threshold mentioned in the header
  })

  it('renders the display name, not the internal agent id', () => {
    const text = formatAlert(
      [{ name: 'radar', usage: usage(99) }],
      (n) => (n === 'radar' ? 'Radar Scout' : n),
    )
    expect(text).toContain('Radar Scout: 99%')
    expect(text).not.toContain('radar:')
  })
})

describe('contextPercentForModel', () => {
  it('computes percent against the model window and clamps', () => {
    expect(contextPercentForModel(100_000, 'claude-sonnet-4-6')).toBe(50) // 100k/200k
    expect(contextPercentForModel(500_000, 'claude-opus-4-8[1m]')).toBe(50) // 500k/1M
    expect(contextPercentForModel(0, 'claude-sonnet-4-6')).toBe(0)
    expect(contextPercentForModel(999_999_999, 'claude-sonnet-4-6')).toBe(100) // clamp
  })
})
