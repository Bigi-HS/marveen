import { describe, it, expect, vi } from 'vitest'
import { runHangSweep, type HangSweepDeps } from '../web/per-agent-pipe-watchdog.js'
import type { HangVerdict } from '../web/pipe-hang-detector.js'

const NOW = 1_700_000_000_000
const hung = (id: string, ms = 120_000): HangVerdict => ({ state: 'hung', hungForMs: ms, toolUseId: id })
const ok = (): HangVerdict => ({ state: 'ok', hungForMs: 0, toolUseId: 'x' })
const none = (): HangVerdict => ({ state: 'none', hungForMs: 0, toolUseId: null })

function deps(over: Partial<HangSweepDeps>): HangSweepDeps {
  return {
    listChannelSubAgents: () => ['solo'],
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
    const r = runHangSweep(NOW, deps({ listChannelSubAgents: () => ['h_recover'], readHangState: () => hung('t1'), reconnect }))
    expect(reconnect).toHaveBeenCalledWith('h_recover')
    expect(r.recovered).toEqual(['h_recover'])
    expect(r.results.h_recover.state).toBe('hung')
  })

  it('does NOT re-drive /mcp for the SAME hung tool_use on the next tick (abandoned call stays in the transcript)', () => {
    const reconnect = vi.fn(() => ({ ok: true, message: 'ok' }))
    const d = deps({ listChannelSubAgents: () => ['h_dedup'], readHangState: () => hung('same-id'), reconnect })
    runHangSweep(NOW, d)
    runHangSweep(NOW + 5000, d) // same hung id still in the transcript
    expect(reconnect).toHaveBeenCalledTimes(1) // acted once, not twice
  })

  it('re-arms when a genuinely NEW hung call appears (different tool_use id)', () => {
    const reconnect = vi.fn(() => ({ ok: true, message: 'ok' }))
    let id = 'first'
    const d = deps({ listChannelSubAgents: () => ['h_rearm'], readHangState: () => hung(id), reconnect })
    runHangSweep(NOW, d)
    id = 'second'
    runHangSweep(NOW + 5000, d)
    expect(reconnect).toHaveBeenCalledTimes(2)
  })

  it('takes NO action when no agent is hung', () => {
    const reconnect = vi.fn(() => ({ ok: true, message: 'ok' }))
    runHangSweep(NOW, deps({ listChannelSubAgents: () => ['h_idle'], readHangState: () => ok(), reconnect }))
    expect(reconnect).not.toHaveBeenCalled()
  })

  it('a hung read that throws is skipped without aborting the sweep', () => {
    const reconnect = vi.fn(() => ({ ok: true, message: 'ok' }))
    const r = runHangSweep(NOW, deps({
      listChannelSubAgents: () => ['boom', 'h_after'],
      readHangState: (n) => { if (n === 'boom') throw new Error('read fail'); return hung('t9') },
      reconnect,
    }))
    expect(r.swept).toEqual(['boom', 'h_after'])
    expect(reconnect).toHaveBeenCalledWith('h_after')
    expect(reconnect).toHaveBeenCalledTimes(1)
  })
})
