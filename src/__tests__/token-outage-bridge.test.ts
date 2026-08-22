import { describe, it, expect, vi } from 'vitest'
import {
  classifyPane,
  runCycle,
  LIMIT_PATTERNS,
  DEFAULT_STALE_OUTAGE_MS,
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
    dismissModal: vi.fn(),
    relaunchSession: vi.fn(() => true),
    staleOutageMs: 20 * 60 * 1000,
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
    // Non-empty queue so the enter-edge creates exactly one card; the point of
    // this test is that a subsequent still-limited cycle does NOT create another.
    const deps = makeDeps({ limited: true, getQueue: () => [msg('pending work')] })
    await runCycle(NOW, deps)
    const r2 = await runCycle(NOW + 30_000, deps)
    expect(r2.transition).toBe('none')
    expect(deps.sendTelegram).toHaveBeenCalledTimes(1)
    expect(deps.createCard).toHaveBeenCalledTimes(1)
  })

  it('ENTER with an empty queue: acks the operator but skips the noise card (9c067880)', async () => {
    // Boss TG4726 / card 9c067880: a usage-limit window with 0 queued inbound is
    // benign -- it must NOT spawn a [Token-outage] card (that was the recurring
    // board noise, 5 such cards in 24h on 07-26). The operator is still ACKed.
    const deps = makeDeps({ limited: true }) // default getQueue -> []
    const r = await runCycle(NOW, deps)
    expect(r.transition).toBe('entered')
    expect(deps.sendTelegram).toHaveBeenCalledTimes(1) // operator still notified
    expect(deps.createCard).not.toHaveBeenCalled() // no benign 0-queued card
    expect(r.captured).toBe(false)
    expect(deps._state().limited).toBe(true) // window is still tracked
    expect(deps._state().capturedCardId).toBeNull()
  })

  it('ENTER then EXIT with an empty queue: still re-dispatches on reset (no card, no loss)', async () => {
    // Skipping the card must not skip the reset re-dispatch -- an empty-queue
    // window still respawns the main session so it resumes cleanly.
    let limited = true
    const deps = makeDeps({ detectLimit: () => ({ limited, resetAtText: null }) })
    await runCycle(NOW, deps) // enter (empty queue -> no card)
    expect(deps.createCard).not.toHaveBeenCalled()
    limited = false
    const r = await runCycle(NOW + 30_000, deps) // exit
    expect(r.transition).toBe('exited')
    expect(deps.redispatch).toHaveBeenCalledTimes(1)
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

describe('auto-dismiss: ENTERED calls dismissModal', () => {
  it('calls dismissModal once when limit is first detected', async () => {
    const deps = makeDeps({ limited: true })
    await runCycle(NOW, deps)
    expect(deps.dismissModal).toHaveBeenCalledTimes(1)
  })

  it('does not call dismissModal on steady-state limited cycles', async () => {
    const deps = makeDeps({ limited: true })
    await runCycle(NOW, deps)          // ENTERED
    await runCycle(NOW + 30_000, deps) // still limited
    expect(deps.dismissModal).toHaveBeenCalledTimes(1)
  })

  it('does not call dismissModal when not limited', async () => {
    const deps = makeDeps({ limited: false })
    await runCycle(NOW, deps)
    expect(deps.dismissModal).not.toHaveBeenCalled()
  })
})

describe('stale-outage guard: relaunchSession after staleOutageMs', () => {
  const STALE_MS = 20 * 60 * 1000

  it('calls relaunchSession once when still limited after staleOutageMs', async () => {
    const deps = makeDeps({ limited: true, staleOutageMs: STALE_MS })
    await runCycle(NOW, deps)                     // ENTERED
    await runCycle(NOW + STALE_MS + 1, deps)      // stale
    expect(deps.relaunchSession).toHaveBeenCalledTimes(1)
    expect(deps._state().staleLimitKilled).toBe(true)
  })

  it('does not call relaunchSession before staleOutageMs elapses', async () => {
    const deps = makeDeps({ limited: true, staleOutageMs: STALE_MS })
    await runCycle(NOW, deps)
    await runCycle(NOW + STALE_MS - 1000, deps)
    expect(deps.relaunchSession).not.toHaveBeenCalled()
  })

  it('does not call relaunchSession a second time (staleLimitKilled idempotent)', async () => {
    const deps = makeDeps({ limited: true, staleOutageMs: STALE_MS })
    await runCycle(NOW, deps)
    await runCycle(NOW + STALE_MS + 1, deps)      // stale -> kill
    await runCycle(NOW + STALE_MS + 60_000, deps) // still limited -> no second kill
    expect(deps.relaunchSession).toHaveBeenCalledTimes(1)
  })

  it('resets staleLimitKilled on a new ENTERED after an EXITED', async () => {
    let limited = true
    const deps = makeDeps({ detectLimit: () => ({ limited, resetAtText: null }), staleOutageMs: STALE_MS })
    await runCycle(NOW, deps)                          // ENTERED
    await runCycle(NOW + STALE_MS + 1, deps)           // stale -> kill
    limited = false
    await runCycle(NOW + STALE_MS + 60_000, deps)      // EXITED
    limited = true
    await runCycle(NOW + STALE_MS + 120_000, deps)     // new ENTERED -> staleLimitKilled resets
    expect(deps._state().staleLimitKilled).toBe(false)
  })
})

// W4 wiring guard: token-outage-bridge default createCard dep uses noa-kanban createCard.
// The production DEFAULT_DEPS.createCard = defaultCreateCard calls createCard from noa-kanban.
// We verify via the OutageDeps injection: the test passes a real createCard spy to confirm
// the card is created with the expected fields when a limit is first detected.
describe('DEFAULT_STALE_OUTAGE_MS literal pin (card 4defece0)', () => {
  it('is exactly 20 minutes (policy change without test update must fail)', () => {
    // Symbolic tests pass at any threshold -- this literal pins the policy value.
    // Ref: symbolic-boundary-test-is-green-at-any-threshold memory entry.
    expect(Math.round(DEFAULT_STALE_OUTAGE_MS / 60000)).toBe(20)
  })
})

describe('W4: token-outage-bridge createCard routed through noa-kanban interface', () => {
  it('runCycle creates a card via the injected createCard dep on first limit detection', async () => {
    const createCard = vi.fn(() => 'card-xyz')
    // Non-empty queue: card creation is now guarded on queued>0 (card 9c067880),
    // so a window with something to preserve is what exercises the wiring.
    const deps = makeDeps({ limited: true, createCard, getQueue: () => [msg('queued work')] })
    const r = await runCycle(NOW, deps)
    expect(createCard).toHaveBeenCalledTimes(1)
    expect(r.state.capturedCardId).toBe('card-xyz')
    expect(r.captured).toBe(true)
  })

  it('createCard receives pending messages in the description', async () => {
    const pending = [msg('hello from queue'), msg('another message')]
    const createCard = vi.fn((_p: AgentMessage[], _r: string | null, _n: number) => 'card-abc')
    const deps = makeDeps({ limited: true, createCard, getQueue: () => pending })
    await runCycle(NOW, deps)
    expect(createCard).toHaveBeenCalledTimes(1)
    const pendingArg = createCard.mock.calls[0][0]
    expect(pendingArg).toHaveLength(2)
  })
})
