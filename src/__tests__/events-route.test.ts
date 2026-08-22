import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { formatSseEvent, tryHandleEvents } from '../web/routes/events.js'
import { emitDashboardEvent, dashboardSubscriberCount, type DashboardEvent } from '../event-bus.js'
import type { RouteContext } from '../web/routes/types.js'

// Card 7c7ea226: the multiplexed /api/events/stream SSE endpoint. Topic in the
// SSE `event:` field, thin JSON in `data:`. Per-connection cleanup (req close,
// and a failed write = half-dead socket) must unsubscribe to avoid a listener
// leak -- NoA build-note #2.

class MockRes extends EventEmitter {
  head?: { status: number; headers: Record<string, string> }
  chunks: string[] = []
  ended = false
  failWrites = false
  writeHead(status: number, headers: Record<string, string>): this {
    this.head = { status, headers }
    return this
  }
  write(chunk: string): boolean {
    if (this.failWrites) throw new Error('EPIPE')
    this.chunks.push(chunk)
    return true
  }
  end(): this { this.ended = true; return this }
}

function makeCtx(over: Partial<{ path: string; method: string }> = {}): {
  ctx: RouteContext; req: EventEmitter; res: MockRes
} {
  const req = new EventEmitter()
  const res = new MockRes()
  const ctx = {
    req: req as unknown as RouteContext['req'],
    res: res as unknown as RouteContext['res'],
    path: over.path ?? '/api/events/stream',
    method: over.method ?? 'GET',
    url: new URL('http://localhost/api/events/stream'),
  } as RouteContext
  return { ctx, req, res }
}

const ev = (over: Partial<DashboardEvent> = {}): DashboardEvent => ({ type: 'kanban', id: 'c1', ...over })

describe('formatSseEvent (card 7c7ea226)', () => {
  it('frames topic in event: and thin payload in data:', () => {
    const e = ev({ type: 'message', id: 'm9', action: 'delivered' })
    expect(formatSseEvent(e)).toBe(`event: message\ndata: ${JSON.stringify(e)}\n\n`)
  })
})

describe('tryHandleEvents (card 7c7ea226)', () => {
  it('ignores non-matching routes', async () => {
    const { ctx } = makeCtx({ path: '/api/kanban' })
    expect(await tryHandleEvents(ctx)).toBe(false)
  })

  it('opens an SSE stream with the right headers and a connected comment', async () => {
    const { ctx, res } = makeCtx()
    expect(await tryHandleEvents(ctx)).toBe(true)
    expect(res.head?.status).toBe(200)
    expect(res.head?.headers['Content-Type']).toBe('text/event-stream')
    expect(res.chunks[0]).toContain(': connected')
  })

  it('forwards a dashboard event to the open stream', async () => {
    const base = dashboardSubscriberCount()
    const { ctx, req, res } = makeCtx()
    await tryHandleEvents(ctx)
    expect(dashboardSubscriberCount()).toBe(base + 1)
    const e = ev({ id: 'card-77', action: 'moved' })
    emitDashboardEvent(e)
    expect(res.chunks.some((c) => c === formatSseEvent(e))).toBe(true)
    req.emit('close')
    expect(dashboardSubscriberCount()).toBe(base)
  })

  it('unsubscribes when the request closes (no listener leak)', async () => {
    const base = dashboardSubscriberCount()
    const { ctx, req, res } = makeCtx()
    await tryHandleEvents(ctx)
    req.emit('close')
    expect(dashboardSubscriberCount()).toBe(base)
    expect(res.ended).toBe(true)
  })

  it('tears down on a failed write (half-dead socket)', async () => {
    const base = dashboardSubscriberCount()
    const { ctx, res } = makeCtx()
    await tryHandleEvents(ctx)
    res.failWrites = true
    emitDashboardEvent(ev())
    expect(dashboardSubscriberCount()).toBe(base)
  })
})
