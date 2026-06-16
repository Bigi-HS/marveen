import { describe, it, expect, vi } from 'vitest'
import {
  emitDashboardEvent,
  subscribeDashboardEvents,
  dashboardSubscriberCount,
  type DashboardEvent,
} from '../event-bus.js'

// Card 7c7ea226 (opencode SSE/event-bus push layer): the in-process bus that
// db.ts write functions emit on and the /api/events/stream SSE route subscribes
// to. Core invariant: a faulty subscriber must NEVER break the DB write that
// triggered the emit, nor block sibling subscribers.

const ev = (over: Partial<DashboardEvent> = {}): DashboardEvent => ({
  type: 'kanban',
  id: 'card-1',
  ...over,
})

describe('event-bus (card 7c7ea226)', () => {
  it('emit with no subscribers does not throw', () => {
    expect(() => emitDashboardEvent(ev())).not.toThrow()
  })

  it('delivers the exact event payload to a subscriber', () => {
    const seen: DashboardEvent[] = []
    const off = subscribeDashboardEvents((e) => seen.push(e))
    const event = ev({ type: 'message', id: 'm-42', action: 'delivered' })
    emitDashboardEvent(event)
    off()
    expect(seen).toEqual([event])
  })

  it('fans out to every subscriber', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = subscribeDashboardEvents(a)
    const offB = subscribeDashboardEvents(b)
    emitDashboardEvent(ev({ id: 'x' }))
    offA(); offB()
    expect(a).toHaveBeenCalledOnce()
    expect(b).toHaveBeenCalledOnce()
  })

  it('isolates a throwing subscriber: emit returns normally and siblings still fire', () => {
    const good = vi.fn()
    const offBad = subscribeDashboardEvents(() => { throw new Error('boom') })
    const offGood = subscribeDashboardEvents(good)
    expect(() => emitDashboardEvent(ev())).not.toThrow()
    offBad(); offGood()
    expect(good).toHaveBeenCalledOnce()
  })

  it('unsubscribe stops delivery', () => {
    const fn = vi.fn()
    const off = subscribeDashboardEvents(fn)
    off()
    emitDashboardEvent(ev())
    expect(fn).not.toHaveBeenCalled()
  })

  it('tracks subscriber count across subscribe/unsubscribe', () => {
    const base = dashboardSubscriberCount()
    const off1 = subscribeDashboardEvents(() => {})
    const off2 = subscribeDashboardEvents(() => {})
    expect(dashboardSubscriberCount()).toBe(base + 2)
    off1()
    expect(dashboardSubscriberCount()).toBe(base + 1)
    off2()
    expect(dashboardSubscriberCount()).toBe(base)
  })
})
