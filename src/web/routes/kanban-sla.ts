/**
 * GET /api/kanban/sla -- SLA-style pre-breach staleness alerts (DASH-033, abb2f275).
 *
 * Returns each active card's staleness state: ok, warning (>= 70% of threshold),
 * breach (>= 100% of threshold), or unknown (no threshold or age unmeasurable).
 *
 * Mirrors the aging motor from 31f24bad/PR#545 + rule engine thresholds.
 * Cards without a priority_score have no SLA threshold (unknown).
 *
 * Response: { cards: SlaCard[], generated_at: number }
 */
import type Database from 'better-sqlite3'
import { getNoaDb } from '../../noa-db.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Per-priority-score stale threshold in seconds (mirrors noa-kanban.ts + kanban.ts).
const STALE_THRESHOLD_SECONDS: Record<number, number> = {
  1: 2 * 3600, 2: 12 * 3600,
  3: 24 * 3600, 4: 24 * 3600,
  5: 3 * 86400, 6: 3 * 86400, 7: 3 * 86400,
  8: 7 * 86400, 9: 7 * 86400, 10: 7 * 86400,
}

// 07-29 bulk-stamp burst: updated_at in this range is unmeasured.
const BULK_STAMP_BURST_START = 1785334212
const BULK_STAMP_BURST_END   = 1785334253

const ACTIVE_STATUSES = new Set(['planned', 'in_progress', 'waiting'])

// Pre-breach warning fires at this fraction of the threshold.
export const SLA_WARNING_FRACTION = 0.7

export type SlaStatus = 'ok' | 'warning' | 'breach' | 'unknown'

export interface SlaCard {
  id: string
  title: string
  status: string
  assignee: string | null
  priority: string
  priority_score: number | null
  age_seconds: number | null
  threshold_seconds: number | null
  breach_fraction: number | null
  sla_status: SlaStatus
}

interface CardRow {
  id: string
  title: string
  status: string
  assignee: string | null
  priority: string
  priority_score: number | null
  last_moved: number | null
  updated_at: number
}

export function computeSlaCards(
  nowSec: number,
  db: Database.Database = getNoaDb(),
): SlaCard[] {
  const rows = db.prepare(
    `SELECT id, title, status, assignee, priority, priority_score, last_moved, updated_at
       FROM kanban_cards
      WHERE status IN ('planned','in_progress','waiting')
        AND (archived_at IS NULL OR archived_at = 0)
      ORDER BY sort_order ASC`
  ).all() as CardRow[]

  return rows.map((row) => {
    const ts = row.last_moved ?? row.updated_at
    let ageSec: number | null = null
    if (ts >= BULK_STAMP_BURST_START && ts <= BULK_STAMP_BURST_END && row.last_moved === null) {
      ageSec = null // unmeasured bulk-stamp
    } else {
      ageSec = nowSec - ts
    }

    const score = row.priority_score
    const threshold = score != null ? (STALE_THRESHOLD_SECONDS[score] ?? null) : null

    let breachFraction: number | null = null
    let slaStatus: SlaStatus = 'unknown'

    if (ageSec !== null && threshold !== null) {
      breachFraction = ageSec / threshold
      if (breachFraction >= 1.0) {
        slaStatus = 'breach'
      } else if (breachFraction >= SLA_WARNING_FRACTION) {
        slaStatus = 'warning'
      } else {
        slaStatus = 'ok'
      }
    }

    return {
      id: row.id,
      title: row.title,
      status: row.status,
      assignee: row.assignee,
      priority: row.priority,
      priority_score: score ?? null,
      age_seconds: ageSec,
      threshold_seconds: threshold,
      breach_fraction: breachFraction !== null ? Number(breachFraction.toFixed(3)) : null,
      sla_status: slaStatus,
    }
  })
}

export async function tryHandleKanbanSla(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx
  if (path !== '/api/kanban/sla' || method !== 'GET') return false

  const nowSec = Math.floor(Date.now() / 1000)
  const cards = computeSlaCards(nowSec)
  json(res, {
    generated_at: nowSec,
    warning_fraction: SLA_WARNING_FRACTION,
    cards,
    summary: {
      ok: cards.filter(c => c.sla_status === 'ok').length,
      warning: cards.filter(c => c.sla_status === 'warning').length,
      breach: cards.filter(c => c.sla_status === 'breach').length,
      unknown: cards.filter(c => c.sla_status === 'unknown').length,
    },
  })
  return true
}
