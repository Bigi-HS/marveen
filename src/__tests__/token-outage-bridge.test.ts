import { describe, it, expect, vi } from 'vitest'
import {
  classifyPane,
  runCycle,
  LIMIT_PATTERNS,
  type OutageDeps,
  type OutageState,
} from '../web/token-outage-bridge.js'
import type { AgentMessage } from '../db.js'

const NOW = 1_700_000_000_000

const msg = (content: string): AgentMessage =>
  ({ id: 1, from_agent: 'x', to_agent: 'marveen', content, status: 'pending', result: null, created_at: 0, delivered_at: null, completed_at: null }) as AgentMessage

// Stateful deps with in-memory persistence so transitions can be exercised across
// cycles using the same deps object. `limited` is mutable for enter/exit tests.
function makeDeps(over: Partial<OutageDeps> & { limited?: boolean; resetAtText?: string | null } = {}): OutageDeps & { _state: () => OutageState } {
  let store: OutageState = { limited: false, enteredAtMs: 0, ackSent: false, capturedCardId: null }
  const { limited = false, resetAtText = null, ...rest } = over
  const deps: OutageDeps = {
    detectLimit: () => ({ limited, resetAtText }),
    sendTelegram: vi.fn(async () => true),
    getQueue: () => [],
    createCard: vi.fn(() => 'card-1'),
    msSinceLastRespawn: () => Number.POSITIVE_INFINITY,
    redispatch: vi.fn(() => true),
    readState: () => store,
    writeState: (s) => { store = s },
    redispatchBackoffMs: 5 * 60 * 1000,
    ...rest,
  }
  return Object.assign(deps, { _state: () => store })
}

describe('classifyPane', () => {
  it('flags a pane showing the usage-limit menu', () => {
    expect(classifyPane('chatting...\nClaude usage limit reached. Try later.').limited).toBe(true)
    expect(classifyPane("you've reached your usage limit").limited).toBe(true)
  })

  it('flags the live session-limit menu (observed 2026-06-07 verbatim)', () => {
    const pane = [
      'What do you want to do?',
      "You've hit your session limit · resets 7:40pm (Europe/Budapest)",
      'Stop and wait for limit to reset',
      'Upgrade your plan',
    ].join('\n')
    const d = classifyPane(pane)
    expect(d.limited).toBe(true)
    expect(d.resetAtText).toBe('7:40pm (Europe/Budapest)')
  })

  it('flags the bare "Stop and wait for limit to reset" menu option', () => {
    expect(classifyPane('❯ 1. Stop and wait for limit to reset').limited).toBe(true)
  })

  it('does not flag the generic menu header / upgrade option alone', () => {
    expect(classifyPane('What do you want to do?\nUpgrade your plan').limited).toBe(false)
  })

  it('does not flag a normal pane', () => {
    expect(classifyPane('❯ working on the PR\n● Done.').limited).toBe(false)
  })

  it('returns not-limited for a null/empty pane', () => {
    expect(classifyPane(null).limited).toBe(false)
    expect(classifyPane('').limited).toBe(false)
  })

  it('extracts the reset time when present', () => {
    const d = classifyPane('Claude usage limit reached. Your limit will reset at 3pm today.')
    expect(d.limited).toBe(true)
    expect(d.resetAtText).toMatch(/3pm/)
  })

  it('only inspects the visible tail, not deep scrollback', () => {
    const filler = Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\n')
    // limit phrase is far above the tail window -> ignored
    expect(classifyPane('usage limit reached\n' + filler).limited).toBe(false)
  })

  it('default patterns are a non-empty set', () => {
    expect(LIMIT_PATTERNS.length).toBeGreaterThan(0)
  })
})

describe('runCycle transitions', () => {
  it('ENTER: acks once + captures the queue to a kanban card', async () => {
    const deps = makeDeps({ limited: true, getQueue: () => [msg('do the thing')] })
    const r = await runCycle(NOW, deps)
    expect(r.transition).toBe('entered')
    expect(deps.sendTelegram).toHaveBeenCalledTimes(1)
    expect((deps.sendTelegram as any).mock.calls[0][0]).toMatch(/Claude-limit/)
    expect(deps.createCard).toHaveBeenCalledTimes(1)
    expect(r.acked).toBe(true)
    expect(r.captured).toBe(true)
    expect(deps._state().limited).toBe(true)
  })

  it('includes the reset time in the ACK when known', async () => {
    const deps = makeDeps({ limited: true, resetAtText: '3pm' })
    await runCycle(NOW, deps)
    expect((deps.sendTelegram as any).mock.calls[0][0]).toMatch(/Reset: 3pm/)
  })

  it('STAY limited: does not re-ack or re-capture on the next cycle', async () => {
    const deps = makeDeps({ limited: true })
    await runCycle(NOW, deps)
    const r2 = await runCycle(NOW + 30_000, deps)
    expect(r2.transition).toBe('none')
    expect(deps.sendTelegram).toHaveBeenCalledTimes(1)
    expect(deps.createCard).toHaveBeenCalledTimes(1)
  })

  it('EXIT: sends back-online + re-dispatches the queue on reset', async () => {
    // enter while limited, then flip to not-limited via a mutable detector
    let limited = true
    const deps = makeDeps({ detectLimit: () => ({ limited, resetAtText: null }) })
    await runCycle(NOW, deps) // enter
    limited = false
    const r = await runCycle(NOW + 30_000, deps) // exit
    expect(r.transition).toBe('exited')
    expect(r.redispatched).toBe(true)
    expect(deps.redispatch).toHaveBeenCalledTimes(1)
    expect((deps.sendTelegram as any).mock.calls.at(-1)[0]).toMatch(/Ujra elek/)
    expect(deps._state().limited).toBe(false)
  })

  it('EXIT but a recent respawn already covers it: skips re-dispatch', async () => {
    let limited = true
    const deps = makeDeps({
      detectLimit: () => ({ limited, resetAtText: null }),
      msSinceLastRespawn: () => 1000, // a respawn happened 1s ago, inside the backoff
    })
    await runCycle(NOW, deps)
    limited = false
    const r = await runCycle(NOW + 30_000, deps)
    expect(r.transition).toBe('exited')
    expect(deps.redispatch).not.toHaveBeenCalled()
    expect(r.redispatched).toBe(false)
  })

  it('never limited: no action', async () => {
    const deps = makeDeps({ limited: false })
    const r = await runCycle(NOW, deps)
    expect(r.transition).toBe('none')
    expect(deps.sendTelegram).not.toHaveBeenCalled()
    expect(deps.redispatch).not.toHaveBeenCalled()
  })

  it('still records the outage even if the ACK send fails', async () => {
    const deps = makeDeps({ limited: true, sendTelegram: vi.fn(async () => false) })
    const r = await runCycle(NOW, deps)
    expect(r.acked).toBe(false)
    expect(deps._state().limited).toBe(true) // we still entered the outage state
  })
})
