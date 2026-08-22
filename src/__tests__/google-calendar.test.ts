import { describe, it, expect } from 'vitest'
import {
  dayBoundsISO,
  listTodayEvents,
  CALENDAR_EVENTS_URL,
} from '../mcp/google-calendar.js'
import type { FetchLike } from '../mcp/google-oauth.js'

describe('dayBoundsISO (Europe/Budapest)', () => {
  it('uses +02:00 in summer (CEST)', () => {
    const now = Date.UTC(2026, 5, 14, 10, 0, 0) // 2026-06-14 12:00 Budapest
    expect(dayBoundsISO(now)).toEqual({
      timeMin: '2026-06-14T00:00:00+02:00',
      timeMax: '2026-06-14T23:59:59+02:00',
    })
  })

  it('uses +01:00 in winter (CET)', () => {
    const now = Date.UTC(2026, 0, 15, 10, 0, 0) // 2026-01-15 11:00 Budapest
    expect(dayBoundsISO(now)).toEqual({
      timeMin: '2026-01-15T00:00:00+01:00',
      timeMax: '2026-01-15T23:59:59+01:00',
    })
  })

  it('picks the LOCAL calendar day, not the UTC day', () => {
    // 2026-06-14 23:30Z is already 2026-06-15 01:30 in Budapest
    const now = Date.UTC(2026, 5, 14, 23, 30, 0)
    expect(dayBoundsISO(now).timeMin).toBe('2026-06-15T00:00:00+02:00')
  })
})

describe('listTodayEvents', () => {
  function fakeFetch(items: unknown[]): { fn: FetchLike; url: () => string; init: () => any } {
    let seenUrl = ''
    let seenInit: any = null
    const fn: FetchLike = async (url, init) => {
      seenUrl = url
      seenInit = init
      return { ok: true, status: 200, json: async () => ({ items }), text: async () => '' }
    }
    return { fn, url: () => seenUrl, init: () => seenInit }
  }

  it('queries the primary calendar with today bounds and a Bearer token', async () => {
    const f = fakeFetch([])
    const now = Date.UTC(2026, 5, 14, 10, 0, 0)
    await listTodayEvents('TOK', now, f.fn)
    const u = new URL(f.url())
    expect(`${u.origin}${u.pathname}`).toBe(CALENDAR_EVENTS_URL)
    expect(u.searchParams.get('timeMin')).toBe('2026-06-14T00:00:00+02:00')
    expect(u.searchParams.get('timeMax')).toBe('2026-06-14T23:59:59+02:00')
    expect(u.searchParams.get('singleEvents')).toBe('true')
    expect(u.searchParams.get('orderBy')).toBe('startTime')
    expect(f.init().headers.Authorization).toBe('Bearer TOK')
  })

  it('normalizes timed and all-day events', async () => {
    const f = fakeFetch([
      { summary: 'Standup', start: { dateTime: '2026-06-14T09:00:00+02:00' }, end: { dateTime: '2026-06-14T09:15:00+02:00' }, location: 'Zoom' },
      { start: { date: '2026-06-14' }, end: { date: '2026-06-15' } },
    ])
    const events = await listTodayEvents('TOK', Date.UTC(2026, 5, 14, 10), f.fn)
    expect(events[0]).toEqual({
      summary: 'Standup',
      start: '2026-06-14T09:00:00+02:00',
      end: '2026-06-14T09:15:00+02:00',
      location: 'Zoom',
      allDay: false,
    })
    expect(events[1].summary).toBe('(no title)')
    expect(events[1].allDay).toBe(true)
  })

  it('throws on a non-ok response', async () => {
    const fn: FetchLike = async () => ({
      ok: false, status: 401, json: async () => ({}), text: async () => 'unauth',
    })
    await expect(listTodayEvents('TOK', Date.now(), fn)).rejects.toThrow(/calendar list failed: 401/)
  })
})
