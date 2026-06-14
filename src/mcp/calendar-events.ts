// Full calendar read+write for the Claudia Google MCP server (v2). Scope:
// calendar. Read (list calendars / list events any range / search) and write
// (create / update-single / update-all / delete) the primary calendar.
//
// SEC-AC7 -- recurring split: calendar_update_event (single instance, unguarded)
// refuses a scope=all request rather than silently promoting it; the all-
// instances edit is the distinct, hard-guarded updateEventAll.
//
// F-AC7 -- undo-snapshot: deleteEvent fetches the full event and writes it to
// deleted-events/<id>.json (0600) BEFORE calling the delete API. If the snapshot
// write fails, the delete is ABORTED (we never destroy data we could not back
// up). A missing event (404) aborts cleanly with {error:"event not found"}.
//
// Egress: this module talks ONLY to www.googleapis.com.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FetchLike } from './google-oauth.js'

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3'
export const CALENDAR_LIST_URL = `${CALENDAR_BASE}/users/me/calendarList`
export const CALENDAR_PRIMARY_EVENTS_URL = `${CALENDAR_BASE}/calendars/primary/events`

const realFetch = fetch as unknown as FetchLike

export interface CalendarSummary {
  id: string
  summary: string
  primary?: boolean
}

export interface EventTime {
  dateTime?: string
  date?: string
  timeZone?: string
}

export interface CalendarEventFull {
  id?: string
  summary?: string
  description?: string
  location?: string
  start?: EventTime
  end?: EventTime
  attendees?: { email?: string; responseStatus?: string }[]
}

export interface EventInput {
  summary?: string
  description?: string
  location?: string
  start?: EventTime
  end?: EventTime
  attendees?: { email: string }[]
}

async function call(
  url: string,
  method: string,
  accessToken: string,
  body: unknown,
  fetchFn: FetchLike,
): Promise<any> {
  const init: any = { method, headers: { Authorization: `Bearer ${accessToken}` } }
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  return fetchFn(url, init)
}

function throwHttp(label: string, status: number, text: string): never {
  throw new Error(`${label} failed: ${status} ${text.slice(0, 200)}`)
}

export async function listCalendars(
  accessToken: string,
  fetchFn: FetchLike = realFetch,
): Promise<{ calendars: CalendarSummary[] }> {
  const res = await call(CALENDAR_LIST_URL, 'GET', accessToken, undefined, fetchFn)
  if (!res.ok) throwHttp('calendar list', res.status, await res.text().catch(() => ''))
  const j = (await res.json()) as { items?: CalendarSummary[] }
  return {
    calendars: (j.items ?? []).map((c) => ({ id: c.id, summary: c.summary, ...(c.primary ? { primary: true } : {}) })),
  }
}

function eventsListUrl(params: { timeMin?: string; timeMax?: string; q?: string }): string {
  const url = new URL(CALENDAR_PRIMARY_EVENTS_URL)
  if (params.timeMin) url.searchParams.set('timeMin', params.timeMin)
  if (params.timeMax) url.searchParams.set('timeMax', params.timeMax)
  if (params.q) url.searchParams.set('q', params.q)
  url.searchParams.set('singleEvents', 'true')
  url.searchParams.set('orderBy', 'startTime')
  url.searchParams.set('maxResults', '250')
  return url.toString()
}

async function fetchEvents(
  accessToken: string,
  params: { timeMin?: string; timeMax?: string; q?: string },
  fetchFn: FetchLike,
): Promise<{ events: CalendarEventFull[] }> {
  const res = await call(eventsListUrl(params), 'GET', accessToken, undefined, fetchFn)
  if (!res.ok) throwHttp('calendar events list', res.status, await res.text().catch(() => ''))
  const j = (await res.json()) as { items?: CalendarEventFull[] }
  return { events: j.items ?? [] }
}

// List events in any [timeMin, timeMax] range (past/present/future), F-AC5b.
export function listEvents(
  accessToken: string,
  params: { timeMin: string; timeMax: string },
  fetchFn: FetchLike = realFetch,
): Promise<{ events: CalendarEventFull[] }> {
  return fetchEvents(accessToken, params, fetchFn)
}

// Text search across the primary calendar.
export function searchEvents(
  accessToken: string,
  params: { q: string; timeMin?: string; timeMax?: string },
  fetchFn: FetchLike = realFetch,
): Promise<{ events: CalendarEventFull[] }> {
  return fetchEvents(accessToken, params, fetchFn)
}

export async function createEvent(
  accessToken: string,
  event: EventInput,
  fetchFn: FetchLike = realFetch,
): Promise<CalendarEventFull> {
  const res = await call(CALENDAR_PRIMARY_EVENTS_URL, 'POST', accessToken, event, fetchFn)
  if (!res.ok) throwHttp('calendar create', res.status, await res.text().catch(() => ''))
  return (await res.json()) as CalendarEventFull
}

// Update a SINGLE event instance. Refuses scope=all (must use updateEventAll).
export async function updateEvent(
  accessToken: string,
  id: string,
  patch: EventInput,
  opts: { scope?: string } = {},
  fetchFn: FetchLike = realFetch,
): Promise<CalendarEventFull | { error: string }> {
  if (opts.scope === 'all') {
    return { error: 'use calendar_update_event_all for all-instances edit' }
  }
  const url = `${CALENDAR_PRIMARY_EVENTS_URL}/${encodeURIComponent(id)}`
  const res = await call(url, 'PATCH', accessToken, patch, fetchFn)
  if (!res.ok) {
    if (res.status === 404) return { error: 'event not found' }
    if (res.status === 403) return { error: 'not owner, cannot modify' }
    throwHttp('calendar update', res.status, await res.text().catch(() => ''))
  }
  return (await res.json()) as CalendarEventFull
}

// Update ALL instances of a recurring event (patch the master). Hard-guarded.
export async function updateEventAll(
  accessToken: string,
  recurringEventId: string,
  patch: EventInput,
  fetchFn: FetchLike = realFetch,
): Promise<CalendarEventFull | { error: string }> {
  const url = `${CALENDAR_PRIMARY_EVENTS_URL}/${encodeURIComponent(recurringEventId)}`
  const res = await call(url, 'PATCH', accessToken, patch, fetchFn)
  if (!res.ok) {
    if (res.status === 404) return { error: 'event not found' }
    throwHttp('calendar update all', res.status, await res.text().catch(() => ''))
  }
  return (await res.json()) as CalendarEventFull
}

// Delete an event with a pre-delete undo-snapshot (F-AC7). Order is load-bearing:
// fetch -> snapshot -> (only on snapshot success) delete.
export async function deleteEvent(
  accessToken: string,
  id: string,
  deletedEventsDir: string,
  fetchFn: FetchLike = realFetch,
): Promise<{ id: string; snapshot: string } | { error: string }> {
  // 1. Fetch the full event for the snapshot. Missing -> abort cleanly.
  const getUrl = `${CALENDAR_PRIMARY_EVENTS_URL}/${encodeURIComponent(id)}`
  const getRes = await call(getUrl, 'GET', accessToken, undefined, fetchFn)
  if (!getRes.ok) {
    if (getRes.status === 404) return { error: 'event not found' }
    throwHttp('calendar get (pre-delete)', getRes.status, await getRes.text().catch(() => ''))
  }
  const event = (await getRes.json()) as CalendarEventFull

  // 2. Write the undo-snapshot (0600). If this throws, the delete is ABORTED:
  //    we never destroy an event we could not back up first.
  const snapshotPath = join(deletedEventsDir, `${id}.json`)
  mkdirSync(deletedEventsDir, { recursive: true, mode: 0o700 })
  writeFileSync(snapshotPath, JSON.stringify(event, null, 2), { encoding: 'utf-8', mode: 0o600 })

  // 3. Only now perform the destructive delete.
  const delRes = await call(getUrl, 'DELETE', accessToken, undefined, fetchFn)
  if (!delRes.ok) {
    if (delRes.status === 404) return { error: 'event not found' }
    throwHttp('calendar delete', delRes.status, await delRes.text().catch(() => ''))
  }
  return { id, snapshot: snapshotPath }
}
