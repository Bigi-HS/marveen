import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the event bus + pane I/O so the watcher logic is observable without tmux.
const emitDashboardEvent = vi.fn()
vi.mock('../event-bus.js', () => ({ emitDashboardEvent: (e: unknown) => emitDashboardEvent(e) }))

const {
  reduceAgentStatus,
  runAgentStatusTick,
  __resetAgentStatusState,
  STABILITY_TICKS,
} = await import('../web/agent-status-watcher.js')

type Obs = { name: string; label: string }

describe('reduceAgentStatus (card edf73bd7 F2)', () => {
  it('seeds an agent on first sight without emitting (transition-only, no boot burst)', () => {
    const { next, emit } = reduceAgentStatus({}, [{ name: 'dave', label: 'idle' }], 2)
    expect(emit).toEqual([])
    expect(next['dave']).toEqual({ lastEmitted: 'idle', candidate: 'idle', stableCount: 1 })
  })

  it('does not emit while the label is unchanged', () => {
    let s = reduceAgentStatus({}, [{ name: 'dave', label: 'idle' }], 2).next
    const r1 = reduceAgentStatus(s, [{ name: 'dave', label: 'idle' }], 2)
    const r2 = reduceAgentStatus(r1.next, [{ name: 'dave', label: 'idle' }], 2)
    expect(r1.emit).toEqual([])
    expect(r2.emit).toEqual([])
  })

  it('suppresses a single-tick flicker (idle -> working -> idle never emits)', () => {
    let s = reduceAgentStatus({}, [{ name: 'dave', label: 'idle' }], 2).next
    const blip = reduceAgentStatus(s, [{ name: 'dave', label: 'working' }], 2) // 1 tick only
    expect(blip.emit).toEqual([])
    const back = reduceAgentStatus(blip.next, [{ name: 'dave', label: 'idle' }], 2)
    expect(back.emit).toEqual([])
  })

  it('emits exactly once on a transition stable for STABILITY_TICKS', () => {
    let s = reduceAgentStatus({}, [{ name: 'dave', label: 'idle' }], 2).next
    const t1 = reduceAgentStatus(s, [{ name: 'dave', label: 'working' }], 2) // tick 1 of working
    expect(t1.emit).toEqual([])
    const t2 = reduceAgentStatus(t1.next, [{ name: 'dave', label: 'working' }], 2) // tick 2 -> stable
    expect(t2.emit).toEqual(['dave'])
    const t3 = reduceAgentStatus(t2.next, [{ name: 'dave', label: 'working' }], 2) // already emitted
    expect(t3.emit).toEqual([])
  })

  it('tracks agents independently', () => {
    let s = reduceAgentStatus({}, [
      { name: 'dave', label: 'idle' },
      { name: 'thor', label: 'idle' },
    ], 2).next
    // dave transitions to working twice; thor stays idle
    s = reduceAgentStatus(s, [
      { name: 'dave', label: 'working' },
      { name: 'thor', label: 'idle' },
    ], 2).next
    const r = reduceAgentStatus(s, [
      { name: 'dave', label: 'working' },
      { name: 'thor', label: 'idle' },
    ], 2)
    expect(r.emit).toEqual(['dave'])
  })

  it('emits again on a later distinct transition (working -> stopped)', () => {
    let s = reduceAgentStatus({}, [{ name: 'dave', label: 'idle' }], 2).next
    s = reduceAgentStatus(s, [{ name: 'dave', label: 'working' }], 2).next
    s = reduceAgentStatus(s, [{ name: 'dave', label: 'working' }], 2).next // emitted working
    s = reduceAgentStatus(s, [{ name: 'dave', label: 'stopped' }], 2).next
    const r = reduceAgentStatus(s, [{ name: 'dave', label: 'stopped' }], 2)
    expect(r.emit).toEqual(['dave'])
  })

  it('a new agent appearing on a later tick seeds without emit', () => {
    let s = reduceAgentStatus({}, [{ name: 'dave', label: 'idle' }], 2).next
    const r = reduceAgentStatus(s, [
      { name: 'dave', label: 'idle' },
      { name: 'kidd', label: 'working' }, // brand new
    ], 2)
    expect(r.emit).toEqual([])
    expect(r.next['kidd']).toEqual({ lastEmitted: 'working', candidate: 'working', stableCount: 1 })
  })
})

describe('runAgentStatusTick (imperative shell, injected deps)', () => {
  beforeEach(() => {
    emitDashboardEvent.mockReset()
    __resetAgentStatusState()
  })

  it('drives the reducer across ticks and emits strict id-only thin-notify frames', () => {
    const observe = vi.fn<() => Obs[]>()
    // tick1 seed idle; tick2 working(1); tick3 working(2) -> emit
    observe
      .mockReturnValueOnce([{ name: 'dave', label: 'idle' }])
      .mockReturnValueOnce([{ name: 'dave', label: 'working' }])
      .mockReturnValueOnce([{ name: 'dave', label: 'working' }])

    runAgentStatusTick(observe as never)
    runAgentStatusTick(observe as never)
    expect(emitDashboardEvent).not.toHaveBeenCalled()
    runAgentStatusTick(observe as never)

    expect(emitDashboardEvent).toHaveBeenCalledOnce()
    const frame = emitDashboardEvent.mock.calls[0]![0] as Record<string, unknown>
    // Strict id-only: ONLY type + id, no label/action/content (egress invariant).
    expect(frame).toEqual({ type: 'agent-status', id: 'dave' })
    expect(Object.keys(frame).sort()).toEqual(['id', 'type'])
  })

  it('STABILITY_TICKS is 2 (locked tuning)', () => {
    expect(STABILITY_TICKS).toBe(2)
  })
})
