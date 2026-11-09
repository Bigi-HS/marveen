// Tests for GET /api/calendar/today (card 01395777, Phase 0E)
// TDD: network-free, calendar fetcher seam.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import {
  tryHandleAppCalendar,
  __setCalendarFetcher,
} from '../web/routes/app-calendar.js'
import type { AgentIdentity } from '../web/agent-token-registry.js'
import type { AppCalendarEvent } from '../types/app.js'

const AUTH: AgentIdentity = { agentId: 'marveen', scopes: ['admin:*'], source: 'operator' }
const ANON: AgentIdentity = { agentId: '', scopes: [], source: 'agent' }

async function call(method: string, path: string, identity = AUTH) {
  const url = new URL('http://x' + path)
  const req = Readable.from([]) as never
  const captured: { status: number; body: any } = { status: 200, body: undefined }
  const res = {
    writeHead(s: number) { captured.status = s; return res },
    end(b?: string) { captured.body = b ? JSON.parse(b) : undefined },
  } as never
  const handled = await tryHandleAppCalendar({ req, res, method, path: url.pathname, url, identity } as never)
  return { handled, ...captured }
}

afterEach(() => __setCalendarFetcher(null))

describe('route guard', () => {
  it('passes through unrelated paths', async () => {
    expect((await call('GET', '/api/kanban')).handled).toBe(false)
  })

  it('passes through POST on calendar', async () => {
    expect((await call('POST', '/api/calendar/today')).handled).toBe(false)
  })
})

describe('GET /api/calendar/today', () => {
  it('requires authentication', async () => {
    __setCalendarFetcher(vi.fn().mockResolvedValue([]))
    const r = await call('GET', '/api/calendar/today', ANON)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(403)
  })

  it('returns events from fetcher', async () => {
    const events: AppCalendarEvent[] = [
      { id: '1', summary: 'Meeting', start: '2026-11-09T10:00:00+01:00', end: '2026-11-09T11:00:00+01:00', location: null, description: null },
    ]
    __setCalendarFetcher(vi.fn().mockResolvedValue(events))
    const r = await call('GET', '/api/calendar/today')
    expect(r.status).toBe(200)
    expect(r.body.events).toHaveLength(1)
    expect(r.body.events[0].summary).toBe('Meeting')
  })

  it('returns empty array when no events', async () => {
    __setCalendarFetcher(vi.fn().mockResolvedValue([]))
    const r = await call('GET', '/api/calendar/today')
    expect(r.status).toBe(200)
    expect(r.body.events).toEqual([])
  })

  it('returns 503 when calendar fetcher throws', async () => {
    __setCalendarFetcher(vi.fn().mockRejectedValue(new Error('no token')))
    const r = await call('GET', '/api/calendar/today')
    expect(r.status).toBe(503)
    expect(r.body.error).toMatch(/calendar/i)
  })
})
