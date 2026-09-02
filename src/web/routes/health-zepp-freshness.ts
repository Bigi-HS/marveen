// GET /api/health/zepp/freshness -- Zepp data freshness status (WELL-022).
// Returns whether today's Zepp daily snapshot exists and is recent.
// Used by the n8n freshness-check workflow (every 30 min, 01:00-23:45) to detect
// missing-data days before Hibiki consumes stale numbers.
// Auth: dashboard bearer (not public; called by n8n via loopback).

import { json } from '../http-helpers.js'
import { defaultZeppStore } from '../zepp/ingest-store.js'
import type { RouteContext } from './types.js'

export interface ZeppFreshnessDeps {
  latestSnapshot: () => { date: string; sourceSyncedAt?: string } | null
  nowBudapest: () => { date: string; hours: number; minutes: number }
}

export interface FreshnessResult {
  latestDate: string | null
  sourceSyncedAt: string | null
  todayDate: string
  isToday: boolean
  /**
   * Whole days the latest snapshot lags behind today (today - latestDate).
   * 0 = data dated today, 1 = yesterday (the normal morning state, since the
   * ingest finalizes the previous day; today is not yet complete), >=2 = a
   * genuine gap. null when the store is empty.
   */
  daysBehind: number | null
  /** 30-min blocks elapsed since 01:00 Budapest. Alert threshold: >=3. */
  blocksSince1am: number
  alert: boolean
  alertReason: string | null
  checkedAt: string
}

/** Whole days between two YYYY-MM-DD dates (to - from). NaN if unparseable. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN
  return Math.round((b - a) / 86_400_000)
}

function budapestNow(): { date: string; hours: number; minutes: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Budapest',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(new Date())
  const get = (type: string) => parts.find(p => p.type === type)!.value
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hours: parseInt(get('hour'), 10),
    minutes: parseInt(get('minute'), 10),
  }
}

export function computeFreshness(deps: ZeppFreshnessDeps): FreshnessResult {
  const { date: todayDate, hours, minutes } = deps.nowBudapest()

  const snap = deps.latestSnapshot()
  const latestDate = snap?.date ?? null
  const sourceSyncedAt = snap?.sourceSyncedAt ?? null

  const isToday = latestDate === todayDate

  // 30-min blocks elapsed since 01:00 Budapest. Clamped to 0 before 01:00.
  const minutesSince1am = hours * 60 + minutes - 60
  const blocksSince1am = minutesSince1am > 0 ? Math.floor(minutesSince1am / 30) : 0

  // How stale the latest snapshot is. Empty store = infinitely stale (no data
  // at all is a genuine gap). An unparseable date is treated the same way so a
  // bad date can never silently read as fresh.
  let daysBehind: number | null
  if (latestDate === null) {
    daysBehind = null
  } else {
    const d = daysBetween(latestDate, todayDate)
    daysBehind = Number.isNaN(d) ? null : d
  }

  // Alert only on a GENUINE gap: the latest snapshot is older than yesterday
  // (>=2 days behind), which is when a downstream consumer would read a truly
  // stale number. latest=yesterday is the normal morning state (the ingest
  // finalizes the previous day; today is not complete yet), so it must NOT
  // alert -- that was the daily false positive. Empty/unparseable store
  // (daysBehind null) is always a gap.
  const isGenuineGap = daysBehind === null || daysBehind >= 2
  const alert = isGenuineGap && blocksSince1am >= 3
  const staleness = daysBehind === null ? 'no data' : `${daysBehind} days behind`
  const alertReason = alert
    ? `Latest Zepp data is from ${latestDate ?? 'never'} (${staleness}), expected at least yesterday relative to today (${todayDate}). ${blocksSince1am} 30-min blocks elapsed since 01:00.`
    : null

  return {
    latestDate,
    sourceSyncedAt,
    todayDate,
    isToday,
    daysBehind,
    blocksSince1am,
    alert,
    alertReason,
    checkedAt: new Date().toISOString(),
  }
}

export function makeDefaultZeppFreshnessDeps(): ZeppFreshnessDeps {
  return {
    latestSnapshot: () => {
      const snap = defaultZeppStore.latest()
      return snap ? { date: snap.date, sourceSyncedAt: snap.sourceSyncedAt } : null
    },
    nowBudapest: budapestNow,
  }
}

let _deps: ZeppFreshnessDeps | null = null

export async function tryHandleZeppFreshness(ctx: RouteContext): Promise<boolean> {
  if (ctx.path !== '/api/health/zepp/freshness' || ctx.method !== 'GET') return false
  if (!_deps) _deps = makeDefaultZeppFreshnessDeps()
  json(ctx.res, computeFreshness(_deps))
  return true
}
