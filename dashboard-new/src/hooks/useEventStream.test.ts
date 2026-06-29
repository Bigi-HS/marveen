import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useEventStream, __TESTING } from './useEventStream'

// jsdom has no EventSource; install a controllable mock that records instances
// so a test can drive onopen/onerror/dispatch and assert reconnect behaviour.
class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  withCredentials: boolean
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  listeners: Record<string, Array<(ev: { data: string }) => void>> = {}
  closed = false

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url
    this.withCredentials = init?.withCredentials ?? false
    MockEventSource.instances.push(this)
  }
  addEventListener(type: string, fn: (ev: { data: string }) => void): void {
    ;(this.listeners[type] ??= []).push(fn)
  }
  close(): void {
    this.closed = true
    this.readyState = 2
  }
  // --- test drivers ---
  emitOpen(): void {
    this.readyState = 1
    this.onopen?.({})
  }
  emitError(): void {
    this.onerror?.({})
  }
  dispatch(type: string, data: unknown = {}): void {
    for (const fn of this.listeners[type] ?? []) fn({ data: JSON.stringify(data) })
  }
  static last(): MockEventSource {
    return MockEventSource.instances[MockEventSource.instances.length - 1]
  }
  static reset(): void {
    MockEventSource.instances = []
  }
}

beforeEach(() => {
  MockEventSource.reset()
  vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource)
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useEventStream connection', () => {
  it('opens an EventSource to the events stream with credentials', () => {
    renderHook(() => useEventStream())
    expect(MockEventSource.instances).toHaveLength(1)
    expect(MockEventSource.last().url).toBe('/api/events/stream')
    expect(MockEventSource.last().withCredentials).toBe(true)
  })

  it('onopen sets connected=true, onerror sets connected=false', () => {
    const { result } = renderHook(() => useEventStream())
    expect(result.current.connected).toBe(false)
    act(() => MockEventSource.last().emitOpen())
    expect(result.current.connected).toBe(true)
    act(() => MockEventSource.last().emitError())
    expect(result.current.connected).toBe(false)
  })
})

describe('useEventStream event -> revision (thin-notify trigger)', () => {
  it('a kanban event bumps revisions.kanban after the coalesce window', () => {
    const { result } = renderHook(() => useEventStream())
    act(() => MockEventSource.last().emitOpen())
    expect(result.current.revisions.kanban).toBe(0)
    act(() => {
      MockEventSource.last().dispatch('kanban', { type: 'kanban', id: '1', action: 'updated' })
      vi.advanceTimersByTime(__TESTING.COALESCE_MS)
    })
    expect(result.current.revisions.kanban).toBe(1)
  })

  it('coalesces a same-type burst into a single revision bump', () => {
    const { result } = renderHook(() => useEventStream())
    act(() => MockEventSource.last().emitOpen())
    act(() => {
      const es = MockEventSource.last()
      es.dispatch('kanban', { id: '1' })
      es.dispatch('kanban', { id: '1' })
      es.dispatch('kanban', { id: '2' })
      vi.advanceTimersByTime(__TESTING.COALESCE_MS)
    })
    // 3 events in one window -> exactly one bump (anti fetch-storm)
    expect(result.current.revisions.kanban).toBe(1)
  })

  it('bumps each event type independently', () => {
    const { result } = renderHook(() => useEventStream())
    act(() => MockEventSource.last().emitOpen())
    act(() => {
      const es = MockEventSource.last()
      es.dispatch('kanban', {})
      es.dispatch('gate', {})
      vi.advanceTimersByTime(__TESTING.COALESCE_MS)
    })
    expect(result.current.revisions.kanban).toBe(1)
    expect(result.current.revisions.gate).toBe(1)
    expect(result.current.revisions.board).toBe(0)
    expect(result.current.revisions.message).toBe(0)
  })

  it('an agent-status event bumps revisions["agent-status"] (card edf73bd7 F2)', () => {
    const { result } = renderHook(() => useEventStream())
    act(() => MockEventSource.last().emitOpen())
    expect(result.current.revisions['agent-status']).toBe(0)
    act(() => {
      // Strict id-only frame, exactly what the server watcher emits.
      MockEventSource.last().dispatch('agent-status', { type: 'agent-status', id: 'dave' })
      vi.advanceTimersByTime(__TESTING.COALESCE_MS)
    })
    expect(result.current.revisions['agent-status']).toBe(1)
    // Independent of the other counters.
    expect(result.current.revisions.kanban).toBe(0)
  })
})

describe('useEventStream reconnect-on-drop', () => {
  it('reconnects with backoff after an error and resets backoff on reopen', () => {
    renderHook(() => useEventStream())
    expect(MockEventSource.instances).toHaveLength(1)

    // First drop: a new EventSource is created after the base backoff.
    act(() => MockEventSource.last().emitError())
    expect(MockEventSource.last().closed).toBe(true)
    act(() => vi.advanceTimersByTime(__TESTING.BASE_BACKOFF_MS))
    expect(MockEventSource.instances).toHaveLength(2)

    // Second drop without a successful open: backoff grows (base*2).
    act(() => MockEventSource.last().emitError())
    act(() => vi.advanceTimersByTime(__TESTING.BASE_BACKOFF_MS))
    expect(MockEventSource.instances).toHaveLength(2) // not yet -- needs 2x
    act(() => vi.advanceTimersByTime(__TESTING.BASE_BACKOFF_MS))
    expect(MockEventSource.instances).toHaveLength(3)

    // A successful open resets the backoff to base again.
    act(() => MockEventSource.last().emitOpen())
    act(() => MockEventSource.last().emitError())
    act(() => vi.advanceTimersByTime(__TESTING.BASE_BACKOFF_MS))
    expect(MockEventSource.instances).toHaveLength(4)
  })

  it('caps the backoff at MAX_BACKOFF_MS', () => {
    renderHook(() => useEventStream())
    // Drive many consecutive errors; the wait never exceeds the cap.
    for (let i = 0; i < 12; i++) {
      act(() => MockEventSource.last().emitError())
      act(() => vi.advanceTimersByTime(__TESTING.MAX_BACKOFF_MS))
    }
    // Each error eventually reconnects; with the cap, advancing MAX each time
    // always produces the next instance (never stalls beyond the cap).
    expect(MockEventSource.instances.length).toBeGreaterThan(10)
  })
})

describe('useEventStream cleanup', () => {
  it('closes the EventSource on unmount and does not reconnect afterwards', () => {
    const { unmount } = renderHook(() => useEventStream())
    const es = MockEventSource.last()
    unmount()
    expect(es.closed).toBe(true)
    const countAfterUnmount = MockEventSource.instances.length
    // A pending reconnect timer must not fire after unmount.
    act(() => vi.advanceTimersByTime(__TESTING.MAX_BACKOFF_MS * 2))
    expect(MockEventSource.instances).toHaveLength(countAfterUnmount)
  })

  it('an error after unmount schedules no reconnect', () => {
    const { unmount } = renderHook(() => useEventStream())
    const es = MockEventSource.last()
    unmount()
    act(() => es.emitError())
    act(() => vi.advanceTimersByTime(__TESTING.MAX_BACKOFF_MS))
    expect(MockEventSource.instances).toHaveLength(1)
  })
})
