import Database from 'better-sqlite3'
import { join } from 'path'
import { STORE_DIR, PROJECT_ROOT } from './config.js'
import { resolveNoaDbPath } from './db-path.js'

export { resolveNoaDbPath }

const NOA_DB_PATH = resolveNoaDbPath(process.env.NOA_DB_PATH, PROJECT_ROOT, join(STORE_DIR, 'noa.db'))

// df9d4686: bound the -wal file so it cannot stay stuck at a historical peak.
// `journal_size_limit` truncates the WAL back down to this cap after a checkpoint
// resets it (the default -1 means "never shrink", which let the WAL bloat to
// ~130MB and caused health-check / CI timeout false-positives). 64MB sits well
// above normal operation (~20MB) yet far below the pathological peak.
export const WAL_JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024

// How often the active TRUNCATE checkpoint runs. A passive autocheckpoint
// (wal_autocheckpoint) resets the WAL for reuse but does NOT truncate the file,
// and under overlapping readers it may never fully reset -- so we force a
// periodic TRUNCATE. Env-overridable; default 15 min (between the rate-limit
// prune and the 60-min delivery-sentinel rotation; frequent enough to keep the
// WAL small without thrashing under load).
export const WAL_CHECKPOINT_INTERVAL_MS =
  Number(process.env.NOA_WAL_CHECKPOINT_INTERVAL_MS) || 15 * 60 * 1000

let _db: Database.Database | null = null
let _walTimer: ReturnType<typeof setInterval> | null = null

export function openNoaDb(path: string): Database.Database {
  const db = new Database(path)
  const jm = (db.pragma('journal_mode = WAL') as Array<{ journal_mode: string }>)[0]?.journal_mode
  if (path !== ':memory:' && jm !== 'wal') {
    throw new Error(`journal_mode expected 'wal', got '${jm}'`)
  }
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('wal_autocheckpoint = 1000')
  // df9d4686: the backstop that caps WAL file size after a reset (see constant).
  db.pragma(`journal_size_limit = ${WAL_JOURNAL_SIZE_LIMIT_BYTES}`)
  return db
}

export function initNoaDb(path: string): void {
  if (_db) _db.close()
  _db = openNoaDb(path)
}

export function getNoaDb(): Database.Database {
  if (!_db) _db = openNoaDb(NOA_DB_PATH)
  return _db
}

// df9d4686: actively checkpoint and TRUNCATE the WAL on the server connection.
// TRUNCATE flushes all reachable frames to the main DB and shrinks the -wal file
// to zero (bounded by journal_size_limit), unlike the passive autocheckpoint that
// only resets it for reuse. Returns the SQLite checkpoint result row
// { busy, log, checkpointed }.
export function checkpointNoaDb(): { busy: number; log: number; checkpointed: number } {
  const db = getNoaDb()
  const res = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{
    busy: number
    log: number
    checkpointed: number
  }>
  return res[0] ?? { busy: 0, log: 0, checkpointed: 0 }
}

// df9d4686: start the periodic TRUNCATE-checkpoint timer. Idempotent (one timer
// per process). Fail-open: a checkpoint error is swallowed so DB maintenance can
// never crash the server. The timer is unref'd so it does not keep the event loop
// alive on its own.
export function startWalMaintenance(intervalMs: number = WAL_CHECKPOINT_INTERVAL_MS): ReturnType<typeof setInterval> {
  if (_walTimer) return _walTimer
  _walTimer = setInterval(() => {
    try {
      checkpointNoaDb()
    } catch {
      /* fail-open: never let WAL maintenance take down the server */
    }
  }, intervalMs)
  if (typeof _walTimer.unref === 'function') _walTimer.unref()
  return _walTimer
}

export function stopWalMaintenance(): void {
  if (_walTimer) {
    clearInterval(_walTimer)
    _walTimer = null
  }
}
