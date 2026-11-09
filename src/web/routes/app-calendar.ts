// Calendar proxy endpoint (Phase 0E, card 01395777)
//
// GET /api/calendar/today -- today + tomorrow events via Claudia Google Cal
//
// Auth: any authenticated identity required.
// The fetcher is injectable for tests to avoid real Google API calls.

import { json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { HEARTBEAT_CALENDAR_ID } from '../../config.js'
import type { RouteContext } from './types.js'
import type { AppCalendarEvent } from '../../types/app.js'

// ---------------------------------------------------------------------------
// Calendar fetcher seam
// ---------------------------------------------------------------------------

type CalendarFetcher = (from: Date, to: Date) => Promise<AppCalendarEvent[]>

let _fetcher: CalendarFetcher | null = null
export function __setCalendarFetcher(fn: CalendarFetcher | null): void { _fetcher = fn }

async function defaultFetcher(from: Date, to: Date): Promise<AppCalendarEvent[]> {
  const { getCalendarEvents } = await import('../../google-api.js')
  const events = await getCalendarEvents(HEARTBEAT_CALENDAR_ID, from, to)
  return events.map(e => ({
    id: (e as any).id ?? '',
    summary: (e as any).summary ?? '',
    start: (e as any).start?.dateTime ?? (e as any).start?.date ?? '',
    end: (e as any).end?.dateTime ?? (e as any).end?.date ?? '',
    location: (e as any).location ?? null,
    description: (e as any).description ?? null,
  }))
}

function getFetcher(): CalendarFetcher {
  if (_fetcher) return _fetcher
  return defaultFetcher
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function tryHandleAppCalendar(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, identity } = ctx

  if (path !== '/api/calendar/today' || method !== 'GET') return false

  if (!identity?.agentId) {
    json(res, { error: 'authentication required' }, 403)
    return true
  }

  const now = new Date()
  const endOfTomorrow = new Date(now)
  endOfTomorrow.setDate(endOfTomorrow.getDate() + 2)
  endOfTomorrow.setHours(0, 0, 0, 0)

  try {
    const events = await getFetcher()(now, endOfTomorrow)
    json(res, { events })
  } catch (err) {
    logger.error({ err }, 'app-calendar: fetch error')
    json(res, { error: 'calendar unavailable' }, 503)
  }
  return true
}
