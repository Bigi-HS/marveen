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
}

export interface CfdSnapshotRow {
  date: string
  planned: number
  in_progress: number
  waiting: number
  done: number
}

const CFD_SOURCE = 'kanban_cfd'
const DEFAULT_DAYS = 30

/**
 * Reads current kanban_cards table and returns status counts.
 * Icebox is excluded (not part of the active flow).
 */
export function buildCfdSnapshot(db: Database.Database = getNoaDb()): CfdMetrics {
  const counts = db.prepare(
    `SELECT status, COUNT(*) as n
       FROM kanban_cards
      WHERE status IN ('planned', 'in_progress', 'waiting', 'done')
      GROUP BY status`
  ).all() as Array<{ status: string; n: number }>

  const byStatus: Record<string, number> = {}
  for (const row of counts) byStatus[row.status] = row.n

  return {
    planned: byStatus['planned'] ?? 0,
    in_progress: byStatus['in_progress'] ?? 0,
    waiting: byStatus['waiting'] ?? 0,
    done: byStatus['done'] ?? 0,
  }
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
      const m = JSON.parse(r.metrics_json) as CfdMetrics
      return {
        date: r.period_date,
        planned: m.planned ?? 0,
        in_progress: m.in_progress ?? 0,
        waiting: m.waiting ?? 0,
        done: m.done ?? 0,
      }
    })
}

export async function tryHandleKanbanCfd(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/kanban/cfd' && method === 'GET') {
    const snapshots = listCfdSnapshots(DEFAULT_DAYS)
    json(res, { snapshots })
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
