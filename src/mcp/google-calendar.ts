// Calendar read for the Claudia Google MCP server. Scope:
// calendar.events.readonly ONLY (reads today's events from the primary calendar;
// never writes). Day bounds are computed in Europe/Budapest so "today" matches
// Dominik's local day, DST-correct.
//
// Egress: this module talks ONLY to www.googleapis.com (see CALENDAR_EVENTS_URL).
import type { FetchLike } from './google-oauth.js'

// The only host this module contacts. *.googleapis.com (Chad egress review).
export const CALENDAR_EVENTS_URL =
  'https://www.googleapis.com/calendar/v3/calendars/primary/events'

const realFetch = fetch as unknown as FetchLike

export const DEFAULT_TZ = 'Europe/Budapest'

export interface CalendarEvent {
  summary: string
  start: string
  end: string
  location?: string
  allDay: boolean
}

// Offset (ms) of `timeZone` from UTC at instant `now`. DST-correct: derived by
// re-interpreting the same instant in the target zone vs UTC.
function tzOffsetMs(now: number, timeZone: string): number {
  const d = new Date(now)
  const asTz = new Date(d.toLocaleString('en-US', { timeZone }))
  const asUtc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }))
  return asTz.getTime() - asUtc.getTime()
}

function offsetISO(ms: number): string {
  const sign = ms >= 0 ? '+' : '-'
  const total = Math.abs(Math.round(ms / 60000))
  const hh = String(Math.floor(total / 60)).padStart(2, '0')
  const mm = String(total % 60).padStart(2, '0')
  return `${sign}${hh}:${mm}`
}

// [timeMin, timeMax] RFC3339 bounds covering the whole of "today" in `timeZone`.
export function dayBoundsISO(
  now: number,
  timeZone: string = DEFAULT_TZ,
): { timeMin: string; timeMax: string } {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now))
  const offset = offsetISO(tzOffsetMs(now, timeZone))
  return {
    timeMin: `${ymd}T00:00:00${offset}`,
    timeMax: `${ymd}T23:59:59${offset}`,
  }
}

function normalizeEvent(it: Record<string, any>): CalendarEvent {
  const start = it.start ?? {}
  const end = it.end ?? {}
  const allDay = Boolean(start.date && !start.dateTime)
  return {
    summary: it.summary ?? '(no title)',
    start: start.dateTime ?? start.date ?? '',
    end: end.dateTime ?? end.date ?? '',
    location: it.location,
    allDay,
  }
}

// List today's events from the primary calendar, ordered by start time.
export async function listTodayEvents(
  accessToken: string,
  now: number,
  fetchFn: FetchLike = realFetch,
  timeZone: string = DEFAULT_TZ,
): Promise<CalendarEvent[]> {
  const { timeMin, timeMax } = dayBoundsISO(now, timeZone)
  const url = new URL(CALENDAR_EVENTS_URL)
  url.searchParams.set('timeMin', timeMin)
  url.searchParams.set('timeMax', timeMax)
  url.searchParams.set('singleEvents', 'true')
  url.searchParams.set('orderBy', 'startTime')
  url.searchParams.set('maxResults', '50')
  const res = await fetchFn(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`calendar list failed: ${res.status} ${t.slice(0, 200)}`)
  }
  const j = (await res.json()) as { items?: Record<string, any>[] }
  return (j.items ?? []).map(normalizeEvent)
}
