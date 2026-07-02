// Analytics snapshot storage (card 54df4c8f, A-layer).
// Persists the per-source daily pull result into noa.db. Additive + migration-safe:
// the table is created via CREATE TABLE IF NOT EXISTS at boot (applyAnalyticsMigrations)
// and is declared in scripts/schema-noa.sql for fresh installs, mirroring the
// board_columns / kanban migration pattern.
//
// Idempotency contract (spec 1): the row key is (source, period_date). A repeated
// pull for the same source+date UPSERTS -- it overwrites the prior snapshot rather
// than inserting a duplicate. status:error rows are stored too (so the dashboard can
// surface a stale/failed source) and are overwritten by a later status:ok pull.

import type Database from 'better-sqlite3'
import { getNoaDb } from '../noa-db.js'

export type AnalyticsSource = 'youtube' | 'twitch'
export type SnapshotStatus = 'ok' | 'error'

export interface AnalyticsSnapshotRow {
  source: AnalyticsSource
  period_date: string        // YYYY-MM-DD -- the "to" date of the pull period; the upsert key
  status: SnapshotStatus
  pulled_at: number          // epoch seconds
  period_from: string | null // YYYY-MM-DD
  period_to: string | null   // YYYY-MM-DD
  metrics_json: string | null // JSON blob of the parsed metrics (ok only)
  reason: string | null      // error category (auth|quota|network|...) -- error only
  detail: string | null      // safe human message, NEVER contains a token
}

// CREATE TABLE IF NOT EXISTS so a live noa.db that predates this feature gains the
// table on the next boot without a destructive rebuild. The UNIQUE(source, period_date)
// constraint is what powers the idempotent UPSERT (ON CONFLICT).
const ANALYTICS_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS analytics_snapshots (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     source       TEXT    NOT NULL,
     period_date  TEXT    NOT NULL,
     status       TEXT    NOT NULL,
     pulled_at    INTEGER NOT NULL,
     period_from  TEXT,
     period_to    TEXT,
     metrics_json TEXT,
     reason       TEXT,
     detail       TEXT,
     UNIQUE(source, period_date)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_analytics_source_date ON analytics_snapshots(source, period_date)`,
]

/**
 * Idempotent, additive schema migration for the analytics snapshot table.
 * Safe to call on every boot; each statement is guarded so a partial schema
 * or an already-migrated DB never bricks startup.
 */
export function applyAnalyticsMigrations(db: Database.Database = getNoaDb()): void {
  for (const stmt of ANALYTICS_MIGRATIONS) {
    try { db.exec(stmt) } catch { /* already exists -- ok */ }
  }
}

/**
 * UPSERT a snapshot row keyed on (source, period_date). A second pull for the same
 * source + date overwrites the prior row instead of duplicating it (spec 1).
 */
export function upsertSnapshot(row: AnalyticsSnapshotRow, db: Database.Database = getNoaDb()): void {
  db.prepare(
    `INSERT INTO analytics_snapshots
       (source, period_date, status, pulled_at, period_from, period_to, metrics_json, reason, detail)
     VALUES
       (@source, @period_date, @status, @pulled_at, @period_from, @period_to, @metrics_json, @reason, @detail)
     ON CONFLICT(source, period_date) DO UPDATE SET
       status       = excluded.status,
       pulled_at    = excluded.pulled_at,
       period_from  = excluded.period_from,
       period_to    = excluded.period_to,
       metrics_json = excluded.metrics_json,
       reason       = excluded.reason,
       detail       = excluded.detail`
  ).run(row)
}

/** Latest snapshot for one source (highest period_date), or null if none stored. */
export function getLatestSnapshot(
  source: AnalyticsSource,
  db: Database.Database = getNoaDb()
): AnalyticsSnapshotRow | null {
  const r = db.prepare(
    `SELECT source, period_date, status, pulled_at, period_from, period_to, metrics_json, reason, detail
       FROM analytics_snapshots
      WHERE source = ?
      ORDER BY period_date DESC
      LIMIT 1`
  ).get(source) as AnalyticsSnapshotRow | undefined
  return r ?? null
}

/**
 * Snapshots for one source over the most recent N days (period_date descending).
 * Powers the 28-day trend sparklines on the dashboard surface.
 */
export function listRecentSnapshots(
  source: AnalyticsSource,
  days: number,
  db: Database.Database = getNoaDb()
): AnalyticsSnapshotRow[] {
  return db.prepare(
    `SELECT source, period_date, status, pulled_at, period_from, period_to, metrics_json, reason, detail
       FROM analytics_snapshots
      WHERE source = ?
      ORDER BY period_date DESC
      LIMIT ?`
  ).all(source, Math.max(1, Math.floor(days))) as AnalyticsSnapshotRow[]
}
