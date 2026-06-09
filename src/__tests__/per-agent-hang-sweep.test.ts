import { describe, it, expect, vi } from 'vitest'
import { runHangSweep, withMainFolded, type HangSweepDeps } from '../web/per-agent-pipe-watchdog.js'
import { MAIN_AGENT_ID } from '../config.js'
import type { HangVerdict } from '../web/pipe-hang-detector.js'

const NOW = 1_700_000_000_000
const hung = (id: string, ms = 120_000): HangVerdict => ({ state: 'hung', hungForMs: ms, toolUseId: id })
const ok = (): HangVerdict => ({ state: 'ok', hungForMs: 0, toolUseId: 'x' })
const none = (): HangVerdict => ({ state: 'none', hungForMs: 0, toolUseId: null })

function deps(over: Partial<HangSweepDeps>): HangSweepDeps {
  return {
    listAgents: () => ['solo'],
    readHangState: () => none(),
    reconnect: () => ({ ok: true, message: 'ok' }),
    thresholdMs: 90_000,
    ...over,
  }
}

describe('runHangSweep', () => {
  it('drives /mcp recovery for a hung agent and reports it recovered', () => {
    const reconnect = vi.fn(() => ({ ok: true, message: 'ok' }))
    // unique agent name so module-level handled-id state does not bleed across tests
    const r = runHangSweep(NOW, deps({ listAgents: () => ['h_recover'], readHangState: () => hung('t1'), reconnect }))
    expect(reconnect).toHaveBeenCalledWith('h_recover')
    expect(r.recovered).toEqual(['h_recover'])
    expect(r.results.h_recover.state).toBe('hung')
  })

  it('does NOT re-drive /mcp for the SAME hung tool_use on the next tick (abandoned call stays in the transcript)', () => {
    const reconnect = vi.fn(() => ({ ok: true, message: 'ok' }))
    const d = deps({ listAgents: () => ['h_dedup'], readHangState: () => hung('same-id'), reconnect })
    runHangSweep(NOW, d)
    runHangSweep(NOW + 5000, d) // same hung id still in the transcript
    expect(reconnect).toHaveBeenCalledTimes(1) // acted once, not twice
  })

  it('re-arms when a genuinely NEW hung call appears (different tool_use id)', () => {
    const reconnect = vi.fn(() => ({ ok: true, message: 'ok' }))
    let id = 'first'
    const d = deps({ listAgents: () => ['h_rearm'], readHangState: () => hung(id), reconnect })
    runHangSweep(NOW, d)
    id = 'second'
    runHangSweep(NOW + 5000, d)
    expect(reconnect).toHaveBeenCalledTimes(2)
  })

  it('takes NO action when no agent is hung', () => {
    const reconnect = vi.fn(() => ({ ok: true, message: 'ok' }))
    runHangSweep(NOW, deps({ listAgents: () => ['h_idle'], readHangState: () => ok(), reconnect }))
    expect(reconnect).not.toHaveBeenCalled()
  })

  it('a hung read that throws is skipped without aborting the sweep', () => {
    const reconnect = vi.fn(() => ({ ok: true, message: 'ok' }))
    const r = runHangSweep(NOW, deps({
      listAgents: () => ['boom', 'h_after'],
      readHangState: (n) => { if (n === 'boom') throw new Error('read fail'); return hung('t9') },
      reconnect,
    }))
    expect(r.swept).toEqual(['boom', 'h_after'])
    expect(reconnect).toHaveBeenCalledWith('h_after')
    expect(reconnect).toHaveBeenCalledTimes(1)
  })

  it('drives /mcp recovery for a HUNG main orchestrator (the fold-in case)', () => {
    const reconnect = vi.fn(() => ({ ok: true, message: 'ok' }))
    const r = runHangSweep(NOW, deps({ listAgents: () => [MAIN_AGENT_ID], readHangState: () => hung('main-1'), reconnect }))
    expect(reconnect).toHaveBeenCalledWith(MAIN_AGENT_ID)
    expect(r.recovered).toEqual([MAIN_AGENT_ID])
  })
})

describe('withMainFolded (orchestrator fold-in decision)', () => {
  it('prepends main when its channels session is alive and not opted out', () => {
    expect(withMainFolded(['a', 'b'], true, false)).toEqual([MAIN_AGENT_ID, 'a', 'b'])
  })

  it('omits main when its channels session is down (never /mcp a dead session)', () => {
    expect(withMainFolded(['a', 'b'], false, false)).toEqual(['a', 'b'])
  })

  it('omits main when the operator opted out via HANG_SWEEP_EXCLUDE_MAIN', () => {
    expect(withMainFolded(['a', 'b'], true, true)).toEqual(['a', 'b'])
  })

  it('never double-counts main if it already appears in the sub-agent list', () => {
    expect(withMainFolded([MAIN_AGENT_ID, 'a'], true, false)).toEqual([MAIN_AGENT_ID, 'a'])
  })
})
