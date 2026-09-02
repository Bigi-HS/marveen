// GET /api/health/zepp/freshness -- Zepp data freshness status (WELL-022).
// Returns whether today's Zepp daily snapshot exists and is recent.
// Used by the n8n freshness-check workflow (every 30 min, 01:00-23:45) to detect
// missing-data days before Hibiki consumes stale numbers.
// Auth: dashboard bearer (not public; called by n8n via loopback).

import { json } from '../http-helpers.js'
import { defaultZeppStore } from '../zepp/ingest-store.js'
import type { RouteContext } from './types.js'

/**
 * Freshness alert tuning. All values configurable (env in production, injected
 * in tests) so the threshold and the overnight quiet window can move without a
 * code change.
 */
export interface ZeppFreshnessConfig {
  /** Alert when the last real sync is older than this many hours. Default 8. */
  syncAgeThresholdHours: number
  /** Quiet-window start hour (inclusive), Budapest local. Default 0 (midnight). */
  quietStartHour: number
  /** Quiet-window end hour (exclusive), Budapest local. Default 8. */
  quietEndHour: number
}

export const DEFAULT_FRESHNESS_CONFIG: ZeppFreshnessConfig = {
  syncAgeThresholdHours: 8,
  quietStartHour: 0,
  quietEndHour: 8,
}

export interface ZeppFreshnessDeps {
  latestSnapshot: () => { date: string; sourceSyncedAt?: string } | null
  nowBudapest: () => { date: string; hours: number; minutes: number }
  /** Absolute wall-clock now in epoch ms, for sync-age math. Injectable for tests. */
  nowMs: () => number
  /** Optional overrides; unset fields fall back to DEFAULT_FRESHNESS_CONFIG. */
  config?: Partial<ZeppFreshnessConfig>
}

export interface FreshnessResult {
  latestDate: string | null
  sourceSyncedAt: string | null
  todayDate: string
  isToday: boolean
  /**
   * Whole days the latest snapshot lags behind today (today - latestDate).
   * Informational only -- NO LONGER drives the alert (Boss 09-02: the freshness
   * alert is based on last-sync age, not the data date, because latest=yesterday
   * is the normal morning state). 0 = today, 1 = yesterday, >=2 = multi-day gap,
   * null = empty store.
   */
  daysBehind: number | null
  /**
   * Hours since the last real source sync (now - sourceSyncedAt). This IS the
   * alert driver. null when there is no sync timestamp (empty store or
   * unparseable) -- treated as an infinitely stale, genuine gap.
   */
  syncAgeHours: number | null
  /** Effective sync-age alert threshold in hours (config, default 8). */
  thresholdHours: number
  /** True when current Budapest time is inside the overnight quiet window. */
  inQuietWindow: boolean
  /** 30-min blocks elapsed since 01:00 Budapest. Informational (legacy field). */
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

/**
 * Whether `hour` falls in the quiet window [start, end). Handles a window that
 * wraps past midnight (start > end, e.g. 22->6). start === end means no window.
 */
function inQuietWindow(hour: number, start: number, end: number): boolean {
  if (start === end) return false
  if (start < end) return hour >= start && hour < end
  return hour >= start || hour < end
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
  const cfg: ZeppFreshnessConfig = { ...DEFAULT_FRESHNESS_CONFIG, ...deps.config }
  const { date: todayDate, hours, minutes } = deps.nowBudapest()

  const snap = deps.latestSnapshot()
  const latestDate = snap?.date ?? null
  const sourceSyncedAt = snap?.sourceSyncedAt ?? null

  const isToday = latestDate === todayDate

  // 30-min blocks since 01:00 Budapest. Legacy informational field (the alert
  // no longer gates on it -- the quiet window does).
  const minutesSince1am = hours * 60 + minutes - 60
  const blocksSince1am = minutesSince1am > 0 ? Math.floor(minutesSince1am / 30) : 0

  // Informational: how many whole days the data date lags. Empty/unparseable
  // -> null. NOT the alert driver anymore (Boss 09-02).
  let daysBehind: number | null
  if (latestDate === null) {
    daysBehind = null
  } else {
    const d = daysBetween(latestDate, todayDate)
    daysBehind = Number.isNaN(d) ? null : d
  }

  // Alert driver: age of the last REAL sync. A missing/unparseable sync
  // timestamp counts as infinitely stale (a genuine gap can never read fresh).
  const syncMs = sourceSyncedAt ? Date.parse(sourceSyncedAt) : NaN
  const syncAgeHours = Number.isNaN(syncMs) ? null : (deps.nowMs() - syncMs) / 3_600_000

  // Stale when the last sync is older than the threshold, or when there is no
  // sync timestamp at all.
  const isStale = syncAgeHours === null || syncAgeHours > cfg.syncAgeThresholdHours
  const quiet = inQuietWindow(hours, cfg.quietStartHour, cfg.quietEndHour)

  // Suppress alerts during the overnight quiet window: an aged sync at 03:00 is
  // expected (the phone syncs in the morning) and Dominik is asleep, so it must
  // not ping. Outside the window, a stale sync is a real signal.
  const alert = isStale && !quiet

  const ageText = syncAgeHours === null
    ? 'no sync timestamp'
    : `${syncAgeHours.toFixed(1)}h since last sync`
  const alertReason = alert
    ? `Zepp data stale: ${ageText} (threshold ${cfg.syncAgeThresholdHours}h). Last sync ${sourceSyncedAt ?? 'never'}, latest data ${latestDate ?? 'never'}, today ${todayDate}.`
    : null

  return {
    latestDate,
    sourceSyncedAt,
    todayDate,
    isToday,
    daysBehind,
    syncAgeHours,
    thresholdHours: cfg.syncAgeThresholdHours,
    inQuietWindow: quiet,
    blocksSince1am,
    alert,
    alertReason,
    checkedAt: new Date().toISOString(),
  }
}

/** Parse an env var as a finite number, falling back when unset/blank/invalid. */
function envNum(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

/** Read the freshness config from env, defaulting per DEFAULT_FRESHNESS_CONFIG. */
export function freshnessConfigFromEnv(): ZeppFreshnessConfig {
  return {
    syncAgeThresholdHours: envNum('ZEPP_FRESHNESS_SYNC_AGE_HOURS', DEFAULT_FRESHNESS_CONFIG.syncAgeThresholdHours),
    quietStartHour: envNum('ZEPP_FRESHNESS_QUIET_START_HOUR', DEFAULT_FRESHNESS_CONFIG.quietStartHour),
    quietEndHour: envNum('ZEPP_FRESHNESS_QUIET_END_HOUR', DEFAULT_FRESHNESS_CONFIG.quietEndHour),
  }
}

export function makeDefaultZeppFreshnessDeps(): ZeppFreshnessDeps {
  return {
    latestSnapshot: () => {
      const snap = defaultZeppStore.latest()
      return snap ? { date: snap.date, sourceSyncedAt: snap.sourceSyncedAt } : null
    },
    nowBudapest: budapestNow,
    nowMs: () => Date.now(),
    config: freshnessConfigFromEnv(),
  }
}

let _deps: ZeppFreshnessDeps | null = null

export async function tryHandleZeppFreshness(ctx: RouteContext): Promise<boolean> {
  if (ctx.path !== '/api/health/zepp/freshness' || ctx.method !== 'GET') return false
  if (!_deps) _deps = makeDefaultZeppFreshnessDeps()
  json(ctx.res, computeFreshness(_deps))
  return true
}
