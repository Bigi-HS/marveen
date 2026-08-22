import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

// Card 7c7ea226 frontend: the dashboard SSE client helper (web/dashboard-events.js,
// loaded as a classic browser script). Two pieces matter and are unit-tested:
//   - makeCoalescer: NoA build-note #1 -- a write-burst (dispatch+move+comment)
//     emits several events; the client must collapse them into ONE refresh so
//     the SSE + any poller don't create a fetch-storm.
//   - initDashboardEvents: wires named SSE topics to coalesced refresh callbacks.

// web/dashboard-events.js is a browser script outside the TS program (rootDir
// is src/). Load it by executing its source so the UMD wrapper attaches to
// globalThis.DashboardEvents -- no cross-boundary import for tsc to type-check.
beforeAll(async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const here = dirname(fileURLToPath(import.meta.url))
  const code = readFileSync(join(here, '../../web/dashboard-events.js'), 'utf-8')
  new Function(code)()
})
function api(): any {
  return (globalThis as any).DashboardEvents
}

describe('makeCoalescer (card 7c7ea226)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('collapses a burst into a single deferred call', () => {
    const fn = vi.fn()
    const trigger = api().makeCoalescer(fn, 120)
    trigger(); trigger(); trigger(); trigger()
    expect(fn).not.toHaveBeenCalled() // deferred, not leading
    vi.advanceTimersByTime(120)
    expect(fn).toHaveBeenCalledOnce()
  })

  it('fires again for a fresh burst after the window', () => {
    const fn = vi.fn()
    const trigger = api().makeCoalescer(fn, 100)
    trigger()
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledOnce()
    trigger()
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

describe('initDashboardEvents (card 7c7ea226)', () => {
  class MockES {
    static instances: MockES[] = []
    url: string
    opts: any
    listeners: Record<string, Array<() => void>> = {}
    constructor(url: string, opts: any) { this.url = url; this.opts = opts; MockES.instances.push(this) }
    addEventListener(type: string, fn: () => void): void {
      (this.listeners[type] ||= []).push(fn)
    }
    fire(type: string): void { (this.listeners[type] || []).forEach((f) => f()) }
  }

  beforeEach(() => { vi.useFakeTimers(); MockES.instances = [] })
  afterEach(() => vi.useRealTimers())

  it('subscribes to the event stream with credentials and routes topics to coalesced refreshes', () => {
    const onKanban = vi.fn()
    const onMessage = vi.fn()
    const es = api().initDashboardEvents({ onKanban, onMessage, delayMs: 120, EventSourceCtor: MockES })
    expect(es).toBeInstanceOf(MockES)
    expect(es.url).toBe('/api/events/stream')
    expect(es.opts).toEqual({ withCredentials: true })

    es.fire('kanban'); es.fire('kanban') // burst
    es.fire('message')
    expect(onKanban).not.toHaveBeenCalled()
    vi.advanceTimersByTime(120)
    expect(onKanban).toHaveBeenCalledOnce() // burst collapsed
    expect(onMessage).toHaveBeenCalledOnce()
  })

  it('returns null when no EventSource implementation is available', () => {
    const es = api().initDashboardEvents({ onKanban() {}, onMessage() {}, EventSourceCtor: null })
    expect(es).toBeNull()
  })
})
