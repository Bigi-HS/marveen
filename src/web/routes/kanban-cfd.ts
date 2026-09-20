/**
 * GET /api/kanban/cfd  -- returns last N days of kanban status snapshots
 * POST /api/kanban/cfd/snapshot  -- captures today's status distribution
 *
 * Storage: analytics_snapshots with source='kanban_cfd'.
 * Metrics shape: { planned, in_progress, waiting, done } -- icebox excluded.
 *
 * Card b60d578c (DASH-030).
 */
import type Database from 'better-sqlite3'
import { getNoaDb } from '../../noa-db.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export interface CfdMetrics {
  planned: number
  in_progress: number
  waiting: number
  done: number
  /**
   * Active (non-icebox) cards whose status is NOT one of the four flow
   * statuses -- a new/unexpected status value. Surfaced here so the total stays
   * complete instead of the card silently vanishing (WELL-027 C7a).
   */
  other: number
}

export interface CfdSnapshotRow {
  date: string
  planned: number
  in_progress: number
  waiting: number
  done: number
  other: number
}

/**
 * A point in the CFD time series. `present` distinguishes a captured snapshot
 * from a synthetic gap point for a day that has no snapshot (WELL-027 C7b), so
 * the chart consumer can render a break rather than interpolate across it.
 */
export interface CfdSeriesPoint extends CfdSnapshotRow {
  present: boolean
}

const CFD_SOURCE = 'kanban_cfd'
const DEFAULT_DAYS = 30
const FLOW_STATUSES = new Set(['planned', 'in_progress', 'waiting', 'done'])

/**
 * Reads current kanban_cards table and returns status counts.
 * Icebox is the parked lane, excluded from the active flow. Every other
 * (non-icebox) card is counted: the four flow statuses fill their own bucket,
 * and any unexpected/new status falls into `other` so the total is complete
 * and a silently-dropped status can never read as flow shrinking (C7a).
 */
export function buildCfdSnapshot(db: Database.Database = getNoaDb()): CfdMetrics {
  const counts = db.prepare(
    `SELECT status, COUNT(*) as n
       FROM kanban_cards
      WHERE status != 'icebox'
      GROUP BY status`
  ).all() as Array<{ status: string; n: number }>

  const metrics: CfdMetrics = { planned: 0, in_progress: 0, waiting: 0, done: 0, other: 0 }
  for (const row of counts) {
    if (FLOW_STATUSES.has(row.status)) {
      metrics[row.status as 'planned' | 'in_progress' | 'waiting' | 'done'] = row.n
    } else {
      metrics.other += row.n
    }
  }
  return metrics
}

/**
 * Upserts a CFD snapshot for the given YYYY-MM-DD date.
 * Repeated calls for the same date overwrite the prior row (idempotent).
 */
export function upsertCfdSnapshot(
  date: string,
  metrics: CfdMetrics,
  db: Database.Database = getNoaDb()
): void {
  db.prepare(
    `INSERT INTO analytics_snapshots
       (source, period_date, status, pulled_at, metrics_json)
     VALUES (?, ?, 'ok', unixepoch(), ?)
     ON CONFLICT(source, period_date) DO UPDATE SET
       status       = 'ok',
       pulled_at    = excluded.pulled_at,
       metrics_json = excluded.metrics_json`
  ).run(CFD_SOURCE, date, JSON.stringify(metrics))
}

/**
 * Returns the most recent N snapshots, sorted ascending by date (oldest first).
 * This order is what the chart expects (left=old, right=new).
 */
export function listCfdSnapshots(
  days: number = DEFAULT_DAYS,
  db: Database.Database = getNoaDb()
): CfdSnapshotRow[] {
  const raw = db.prepare(
    `SELECT period_date, metrics_json
       FROM analytics_snapshots
      WHERE source = ? AND status = 'ok'
      ORDER BY period_date DESC
      LIMIT ?`
  ).all(CFD_SOURCE, Math.max(1, Math.floor(days))) as Array<{ period_date: string; metrics_json: string }>

  return raw
    .reverse() // oldest first
    .map(r => {
      const m = JSON.parse(r.metrics_json) as Partial<CfdMetrics>
      return {
        date: r.period_date,
        planned: m.planned ?? 0,
        in_progress: m.in_progress ?? 0,
        waiting: m.waiting ?? 0,
        done: m.done ?? 0,
        // Older snapshots predate the `other` bucket; absent key -> 0.
        other: m.other ?? 0,
      }
    })
}

/** One calendar day (in ms). Snapshot dates are pure YYYY-MM-DD (UTC-anchored). */
const DAY_MS = 24 * 60 * 60 * 1000

/** Parse a YYYY-MM-DD date to a UTC-midnight epoch-ms. */
function dateToUtcMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`)
}

/** Format a UTC-midnight epoch-ms back to YYYY-MM-DD. */
function utcMsToDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Expand a list of captured snapshots (ascending by date) into a dense daily
 * series spanning first..last date. Days with a captured snapshot are marked
 * present=true; missing days are emitted as explicit gap points (present=false,
 * zeroed metrics) so the chart renders a break instead of interpolating across
 * a data gap (WELL-027 C7b). Empty/single-row input passes through unchanged.
 */
export function buildCfdSeries(rows: CfdSnapshotRow[]): CfdSeriesPoint[] {
  if (rows.length === 0) return []
  const byDate = new Map(rows.map(r => [r.date, r]))
  const startMs = dateToUtcMs(rows[0].date)
  const endMs = dateToUtcMs(rows[rows.length - 1].date)

  const series: CfdSeriesPoint[] = []
  for (let ms = startMs; ms <= endMs; ms += DAY_MS) {
    const date = utcMsToDate(ms)
    const row = byDate.get(date)
    if (row) {
      series.push({ ...row, present: true })
    } else {
      series.push({ date, planned: 0, in_progress: 0, waiting: 0, done: 0, other: 0, present: false })
    }
  }
  return series
}

export async function tryHandleKanbanCfd(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/kanban/cfd' && method === 'GET') {
    const snapshots = listCfdSnapshots(DEFAULT_DAYS)
    // Gap-aware dense series so the chart cannot silently bridge a missing day.
    const series = buildCfdSeries(snapshots)
    json(res, { snapshots, series })
    return true
  }

  if (path === '/api/kanban/cfd/snapshot' && method === 'POST') {
    const today = new Date().toISOString().slice(0, 10)
    const metrics = buildCfdSnapshot()
    upsertCfdSnapshot(today, metrics)
    json(res, { ok: true, date: today, metrics })
    return true
  }

  return false
}
