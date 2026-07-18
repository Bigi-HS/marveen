// GET /api/bond/srs-due-count -- read-only SRS-due snapshot from the Bond agent's
// vocab DB (card cd2bd7b9, n8n Tier-A). The fleet n8n instance has executeCommand
// HARD-DISABLED, so the scheduled "vocab invite" workflow reads this loopback REST
// endpoint via its httpRequest node instead of shelling out.
//
// Design constraints:
//   - READ-ONLY: opens agents/bond/bond.db with { readonly, fileMustExist }. It
//     never writes, migrates, or creates the file; a missing/unreadable DB yields
//     503 rather than materializing an empty DB.
//   - No secrets in the payload: only the due count, the next-due words, and the
//     last-session recency. The connection is closed after every request (the DB
//     is owned and written by the Bond agent; we take a fresh read each call).
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../../config.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const DEFAULT_TOP_N = 3
const MAX_TOP_N = 10

// Resolved per request (not at module load) so tests can point BOND_DB_PATH at a
// fixture without import-order coupling.
function bondDbPath(): string {
  return process.env.BOND_DB_PATH || join(PROJECT_ROOT, 'agents/bond/bond.db')
}

export interface SrsDueSummary {
  due_count: number
  top_words: string[]
  hours_since_session: number | null
  last_session_date: string | null
}

// Clamp top_n into [1, MAX_TOP_N]; a missing or non-numeric value falls back to
// the default. Never 400s -- an out-of-range hint just saturates.
export function parseTopN(raw: string | null): number {
  if (raw === null) return DEFAULT_TOP_N
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_TOP_N
  return Math.min(Math.max(Math.trunc(n), 1), MAX_TOP_N)
}

/**
 * Pure aggregation over a Bond vocab DB handle. Exported for unit tests (seed an
 * in-memory DB); the route wraps it with open/close + error handling.
 *
 * `last_session_date` uses the `unixepoch` modifier: ended_at is stored as unix
 * seconds, and datetime()/date() without that modifier would misread the integer
 * as a Julian day number (yielding a year-2000 date).
 */
export function computeSrsDue(db: Database.Database, topN: number): SrsDueSummary {
  const dueCount = (
    db.prepare('SELECT COUNT(*) AS n FROM vocab WHERE review_due_epoch <= unixepoch()').get() as { n: number }
  ).n

  const topWords =
    dueCount === 0
      ? []
      : (
          db
            .prepare(
              'SELECT word FROM vocab WHERE review_due_epoch <= unixepoch() ORDER BY review_due_epoch ASC LIMIT ?',
            )
            .all(topN) as Array<{ word: string }>
        ).map((r) => r.word)

  const session = db
    .prepare(
      `SELECT (unixepoch() - MAX(ended_at)) / 3600 AS hours,
              date(MAX(ended_at), 'unixepoch', 'localtime') AS last_date
       FROM sessions WHERE turn_count >= 5`,
    )
    .get() as { hours: number | null; last_date: string | null }

  return {
    due_count: dueCount,
    top_words: topWords,
    hours_since_session: session.hours ?? null,
    last_session_date: session.last_date ?? null,
  }
}

function unavailable(res: RouteContext['res']): void {
  json(res, { error: 'bond_db_unavailable', message: 'Cannot read agents/bond/bond.db' }, 503)
}

export async function tryHandleBondSrs(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx
  if (path !== '/api/bond/srs-due-count' || method !== 'GET') return false

  const topN = parseTopN(url.searchParams.get('top_n'))

  let db: Database.Database
  try {
    db = new Database(bondDbPath(), { readonly: true, fileMustExist: true })
  } catch {
    unavailable(res)
    return true
  }
  try {
    json(res, computeSrsDue(db, topN))
  } catch {
    unavailable(res)
  } finally {
    db.close()
  }
  return true
}
