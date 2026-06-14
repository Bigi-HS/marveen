import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FetchLike } from '../mcp/google-oauth.js'
import {
  listCalendars,
  listEvents,
  searchEvents,
  createEvent,
  updateEvent,
  updateEventAll,
  deleteEvent,
  CALENDAR_LIST_URL,
  CALENDAR_PRIMARY_EVENTS_URL,
} from '../mcp/calendar-events.js'

function jsonRes(obj: unknown, ok = true, status = 200): any {
  return { ok, status, json: async () => obj, text: async () => JSON.stringify(obj) }
}
function capturing(response: any) {
  const calls: Array<{ url: string; method: string; body: any }> = []
  const fn = (async (url: string, init: any) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined })
    return response
  }) as unknown as FetchLike
  return { fn, calls }
}
function router(routes: Array<{ match: (url: string, method: string) => boolean; res: any }>) {
  const calls: Array<{ url: string; method: string; body: any }> = []
  const fn = (async (url: string, init: any) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined })
    for (const r of routes) if (r.match(url, method)) return r.res
    throw new Error(`no stub for ${method} ${url}`)
  }) as unknown as FetchLike
  return { fn, calls }
}
const neverFetch = (async () => {
  throw new Error('fetch must not be called')
}) as unknown as FetchLike

describe('calendar egress (SEC-AC8)', () => {
  it('targets www.googleapis.com only', () => {
    expect(CALENDAR_LIST_URL.startsWith('https://www.googleapis.com/calendar/')).toBe(true)
    expect(CALENDAR_PRIMARY_EVENTS_URL.startsWith('https://www.googleapis.com/calendar/')).toBe(true)
  })
})

describe('listCalendars', () => {
  it('lists accessible calendars', async () => {
    const { fn } = capturing(jsonRes({ items: [{ id: 'primary', summary: 'Me', primary: true }, { id: 'work@x', summary: 'Work' }] }))
    const out = await listCalendars('tok', fn)
    expect(out.calendars).toHaveLength(2)
    expect(out.calendars[0]).toEqual({ id: 'primary', summary: 'Me', primary: true })
  })
})

describe('listEvents (F-AC5b)', () => {
  it('passes timeMin/timeMax and returns events across the range', async () => {
    const { fn, calls } = capturing(jsonRes({ items: [{ summary: 'Past', start: { dateTime: '2026-01-02T10:00:00+01:00' }, end: { dateTime: '2026-01-02T11:00:00+01:00' } }] }))
    const out = await listEvents('tok', { timeMin: '2026-01-01T00:00:00+01:00', timeMax: '2026-12-31T23:59:59+01:00' }, fn)
    expect(calls[0].url).toContain('timeMin=2026-01-01')
    expect(calls[0].url).toContain('timeMax=2026-12-31')
    expect(calls[0].url).toContain('singleEvents=true')
    expect(out.events[0].summary).toBe('Past')
  })
})

describe('searchEvents', () => {
  it('passes the q query param', async () => {
    const { fn, calls } = capturing(jsonRes({ items: [] }))
    await searchEvents('tok', { q: 'dentist' }, fn)
    expect(calls[0].url).toContain('q=dentist')
  })
})

describe('createEvent (F-AC6)', () => {
  it('POSTs a new event and returns its id', async () => {
    const { fn, calls } = capturing(jsonRes({ id: 'ev1', summary: 'Lunch' }))
    const out = (await createEvent('tok', { summary: 'Lunch', start: { dateTime: '2026-06-20T12:00:00+02:00' }, end: { dateTime: '2026-06-20T13:00:00+02:00' } }, fn)) as any
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe(CALENDAR_PRIMARY_EVENTS_URL)
    expect(calls[0].body.summary).toBe('Lunch')
    expect(out.id).toBe('ev1')
  })
})

describe('updateEvent (single, SEC-AC7)', () => {
  it('PATCHes a single instance', async () => {
    const { fn, calls } = capturing(jsonRes({ id: 'ev1', summary: 'Lunch v2' }))
    const out = (await updateEvent('tok', 'ev1', { summary: 'Lunch v2' }, {}, fn)) as any
    expect(calls[0].method).toBe('PATCH')
    expect(calls[0].url).toBe(`${CALENDAR_PRIMARY_EVENTS_URL}/ev1`)
    expect(out.summary).toBe('Lunch v2')
  })

  it('rejects scope=all WITHOUT any API call (must use the _all tool)', async () => {
    const out = (await updateEvent('tok', 'ev1', { summary: 'x' }, { scope: 'all' }, neverFetch)) as any
    expect(out).toEqual({ error: 'use calendar_update_event_all for all-instances edit' })
  })
})

describe('updateEventAll (recurring, guarded)', () => {
  it('PATCHes the recurring master event', async () => {
    const { fn, calls } = capturing(jsonRes({ id: 'rec1', summary: 'Standup v2' }))
    const out = (await updateEventAll('tok', 'rec1', { summary: 'Standup v2' }, fn)) as any
    expect(calls[0].method).toBe('PATCH')
    expect(calls[0].url).toBe(`${CALENDAR_PRIMARY_EVENTS_URL}/rec1`)
    expect(out.id).toBe('rec1')
  })
})

describe('deleteEvent (F-AC7 undo-snapshot, guarded)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cal-del-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a 0600 undo-snapshot BEFORE deleting, then deletes', async () => {
    const event = { id: 'ev5', summary: 'Doctor', start: { dateTime: '2026-06-20T09:00:00+02:00' }, end: { dateTime: '2026-06-20T10:00:00+02:00' }, description: 'checkup', attendees: [{ email: 'doc@x.com' }] }
    const { fn, calls } = router([
      { match: (u, m) => m === 'GET' && u.includes('/events/ev5'), res: jsonRes(event) },
      { match: (u, m) => m === 'DELETE' && u.includes('/events/ev5'), res: jsonRes({}, true, 204) },
    ])
    const out = (await deleteEvent('tok', 'ev5', dir, fn)) as any
    // snapshot written before delete
    const snapPath = join(dir, 'ev5.json')
    expect(existsSync(snapPath)).toBe(true)
    const saved = JSON.parse(readFileSync(snapPath, 'utf-8'))
    expect(saved.id).toBe('ev5')
    expect(saved.summary).toBe('Doctor')
    expect(saved.description).toBe('checkup')
    expect(saved.attendees[0].email).toBe('doc@x.com')
    expect(statSync(snapPath).mode & 0o777).toBe(0o600)
    // GET (snapshot fetch) precedes DELETE
    expect(calls[0].method).toBe('GET')
    expect(calls[1].method).toBe('DELETE')
    expect(out).toEqual({ id: 'ev5', snapshot: snapPath })
  })

  it('aborts (no DELETE) when the event is already gone (404)', async () => {
    const { fn, calls } = router([
      { match: (u, m) => m === 'GET' && u.includes('/events/gone'), res: jsonRes({ error: { code: 404 } }, false, 404) },
    ])
    const out = (await deleteEvent('tok', 'gone', dir, fn)) as any
    expect(out).toEqual({ error: 'event not found' })
    expect(calls.every((c) => c.method !== 'DELETE')).toBe(true)
    expect(existsSync(join(dir, 'gone.json'))).toBe(false)
  })

  it('aborts the delete if the snapshot cannot be written', async () => {
    const event = { id: 'ev6', summary: 'X' }
    const { fn, calls } = router([
      { match: (u, m) => m === 'GET' && u.includes('/events/ev6'), res: jsonRes(event) },
      { match: (u, m) => m === 'DELETE', res: jsonRes({}, true, 204) },
    ])
    // a non-existent, non-creatable snapshot dir (a path under a file) forces a write failure
    const badDir = join(dir, 'afile', 'nested')
    rmSync(dir, { recursive: true, force: true })
    // recreate dir as a FILE so mkdir under it fails
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'afile'), 'x')
    await expect(deleteEvent('tok', 'ev6', badDir, fn)).rejects.toThrow()
    expect(calls.every((c) => c.method !== 'DELETE')).toBe(true)
  })
})
