// P0 Telemetry event bus (card 8b3b0408, v2-spec-p0-telemetry.md).
//
// telemetry_event: append-only event log (raw, TTL 30-90 days).
// telemetry_daily: rolled-up daily aggregates (permanent).
//
// Consumers: POST /api/telemetry (hook + direct ingest),
//            GET /api/telemetry/edges (graph layer, P5),
//            GET /api/telemetry/series (trend, P5).
// Rollup + purge: separate job (P0 API phase).

import Database from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

export function migrateTelemetryTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry_event (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      actor       TEXT    NOT NULL,
      verb        TEXT    NOT NULL,
      object      TEXT,
      object_type TEXT,
      weight      INTEGER DEFAULT 1,
      model       TEXT,
      tokens_in   INTEGER,
      tokens_out  INTEGER,
      cost_usd    REAL,
      status      TEXT,
      meta        TEXT
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tel_ts ON telemetry_event(ts)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tel_actor_verb ON telemetry_event(actor, verb, ts)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tel_edge ON telemetry_event(actor, object, ts)`)

  // Partial unique index for Tier-B at-least-once dedup (meta->>'event_key').
  // SQLite >= 3.38 required for ->>. Requires 3.49.2 in prod (verified).
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tel_event_key
      ON telemetry_event(json_extract(meta, '$.event_key'))
      WHERE json_extract(meta, '$.event_key') IS NOT NULL
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry_daily (
      day         TEXT    NOT NULL,
      actor       TEXT    NOT NULL DEFAULT '',
      object      TEXT    NOT NULL DEFAULT '',
      verb        TEXT    NOT NULL DEFAULT '',
      count       INTEGER,
      weight_sum  INTEGER,
      tokens_in   INTEGER,
      tokens_out  INTEGER,
      cost_usd    REAL,
      PRIMARY KEY (day, actor, object, verb)
    )
  `)

  // Rollup checkpoint: purge job only removes days with a completed checkpoint.
  db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry_rollup_checkpoint (
      day         TEXT PRIMARY KEY,
      completed_at INTEGER NOT NULL
    )
  `)
}

// ---------------------------------------------------------------------------
// PII guard — meta allowlist (§5b)
// ---------------------------------------------------------------------------

// Only these keys survive in the persisted meta JSON.
const META_ALLOWLIST = new Set([
  'session_id', 'cron_name', 'anomaly_flag', 'card_id',
  'event_key', 'model', 'status_detail',
])
const META_VALUE_MAX = 256

export function sanitizeMeta(raw: unknown): string | null {
  if (raw == null) return null
  let obj: Record<string, unknown>
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw) } catch { return null }
  } else if (typeof raw === 'object' && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>
  } else {
    return null
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (!META_ALLOWLIST.has(k)) continue
    const s = typeof v === 'string' ? v : String(v)
    out[k] = s.length > META_VALUE_MAX ? s.slice(0, META_VALUE_MAX) + '...' : s
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

export interface TelemetryEventInput {
  ts?: number         // epoch ms, defaults to Date.now()
  actor: string
  verb: string
  object?: string
  object_type?: string
  weight?: number
  model?: string
  tokens_in?: number
  tokens_out?: number
  cost_usd?: number
  status?: string
  meta?: unknown
}

const INSERT_SQL = `
  INSERT INTO telemetry_event
    (ts, actor, verb, object, object_type, weight, model, tokens_in, tokens_out, cost_usd, status, meta)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`

export function insertTelemetryEvent(
  db: Database.Database,
  input: TelemetryEventInput,
  nowMs = Date.now(),
): number {
  const meta = sanitizeMeta(input.meta)
  const info = db.prepare(INSERT_SQL).run(
    input.ts ?? nowMs,
    input.actor,
    input.verb,
    input.object ?? null,
    input.object_type ?? null,
    input.weight ?? 1,
    input.model ?? null,
    input.tokens_in ?? null,
    input.tokens_out ?? null,
    input.cost_usd ?? null,
    input.status ?? null,
    meta,
  )
  return info.lastInsertRowid as number
}

// Batch insert (array). Each item goes through the same sanitizeMeta guard.
// Wrapped in a transaction for atomicity.
export function insertTelemetryBatch(
  db: Database.Database,
  events: TelemetryEventInput[],
  nowMs = Date.now(),
): number {
  if (events.length === 0) return 0
  const stmt = db.prepare(INSERT_SQL)
  const tx = db.transaction(() => {
    for (const e of events) {
      const meta = sanitizeMeta(e.meta)
      stmt.run(
        e.ts ?? nowMs,
        e.actor,
        e.verb,
        e.object ?? null,
        e.object_type ?? null,
        e.weight ?? 1,
        e.model ?? null,
        e.tokens_in ?? null,
        e.tokens_out ?? null,
        e.cost_usd ?? null,
        e.status ?? null,
        meta,
      )
    }
  })
  tx()
  return events.length
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export interface EdgeRow {
  actor: string
  object: string
  verb: string
  weight_sum: number
  count: number
}

export function queryTelemetryEdges(
  db: Database.Database,
  opts: { fromTs?: number; toTs?: number; actor?: string; limit?: number } = {},
): EdgeRow[] {
  const now = Date.now()
  const fromTs = opts.fromTs ?? now - 30 * 24 * 60 * 60 * 1000  // default: last 30 days
  const toTs = opts.toTs ?? now
  const limit = Math.min(opts.limit ?? 500, 2000)

  if (opts.actor) {
    return db.prepare(`
      SELECT actor, COALESCE(object, '') AS object, verb,
             SUM(weight) AS weight_sum, COUNT(*) AS count
        FROM telemetry_event
       WHERE ts >= ? AND ts <= ? AND actor = ? AND object IS NOT NULL
       GROUP BY actor, object, verb
       ORDER BY weight_sum DESC
       LIMIT ?
    `).all(fromTs, toTs, opts.actor, limit) as EdgeRow[]
  }

  return db.prepare(`
    SELECT actor, COALESCE(object, '') AS object, verb,
           SUM(weight) AS weight_sum, COUNT(*) AS count
      FROM telemetry_event
     WHERE ts >= ? AND ts <= ? AND object IS NOT NULL
     GROUP BY actor, object, verb
     ORDER BY weight_sum DESC
     LIMIT ?
  `).all(fromTs, toTs, limit) as EdgeRow[]
}

export interface CountRow {
  actor: string
  verb: string
  count: number
}

export function countTelemetryEvents(
  db: Database.Database,
  opts: { fromTs?: number; actor?: string; verb?: string } = {},
): number {
  const fromTs = opts.fromTs ?? 0
  if (opts.actor && opts.verb) {
    return (db.prepare(
      'SELECT COUNT(*) FROM telemetry_event WHERE ts >= ? AND actor = ? AND verb = ?'
    ).pluck().get(fromTs, opts.actor, opts.verb) as number) ?? 0
  }
  if (opts.actor) {
    return (db.prepare(
      'SELECT COUNT(*) FROM telemetry_event WHERE ts >= ? AND actor = ?'
    ).pluck().get(fromTs, opts.actor) as number) ?? 0
  }
  return (db.prepare(
    'SELECT COUNT(*) FROM telemetry_event WHERE ts >= ?'
  ).pluck().get(fromTs) as number) ?? 0
}

// ---------------------------------------------------------------------------
// Rollup — daily aggregates (§3 HIBRID, §3 FLAG-3)
// ---------------------------------------------------------------------------

// Aggregate a single UTC day from telemetry_event into telemetry_daily.
// INSERT OR REPLACE makes this idempotent; writes a checkpoint after success.
// Returns the number of distinct (actor, object, verb) groups upserted.
export function rollupTelemetryDay(
  db: Database.Database,
  day: string,         // 'YYYY-MM-DD' UTC
  nowMs = Date.now(),
): number {
  let changes = 0
  const tx = db.transaction(() => {
    const result = db.prepare(`
      INSERT OR REPLACE INTO telemetry_daily
        (day, actor, object, verb, count, weight_sum, tokens_in, tokens_out, cost_usd)
      SELECT
        date(ts / 1000, 'unixepoch')       AS day,
        actor,
        COALESCE(object, '')               AS object,
        verb,
        COUNT(*)                           AS count,
        SUM(COALESCE(weight, 1))           AS weight_sum,
        SUM(COALESCE(tokens_in, 0))        AS tokens_in,
        SUM(COALESCE(tokens_out, 0))       AS tokens_out,
        SUM(COALESCE(cost_usd, 0.0))       AS cost_usd
      FROM telemetry_event
      WHERE date(ts / 1000, 'unixepoch') = ?
      GROUP BY date(ts / 1000, 'unixepoch'), actor, COALESCE(object, ''), verb
    `).run(day)
    changes = result.changes
    db.prepare(`
      INSERT OR REPLACE INTO telemetry_rollup_checkpoint (day, completed_at)
      VALUES (?, ?)
    `).run(day, nowMs)
  })
  tx()
  return changes
}

// ---------------------------------------------------------------------------
// Purge — delete raw events only after checkpoint (§3 FLAG-3)
// ---------------------------------------------------------------------------

// Delete raw telemetry_event rows for every day that (a) has a rollup checkpoint
// and (b) is strictly before `beforeDay`. Returns total rows deleted.
export function purgeTelemetryRaw(
  db: Database.Database,
  beforeDay: string,  // 'YYYY-MM-DD' UTC — days < this value are eligible
): number {
  const checkpointedDays = (db.prepare(
    "SELECT day FROM telemetry_rollup_checkpoint WHERE day < ?"
  ).all(beforeDay) as { day: string }[]).map(r => r.day)

  if (checkpointedDays.length === 0) return 0

  let total = 0
  const stmt = db.prepare(
    "DELETE FROM telemetry_event WHERE date(ts / 1000, 'unixepoch') = ?"
  )
  for (const d of checkpointedDays) {
    total += stmt.run(d).changes
  }
  return total
}

// ---------------------------------------------------------------------------
// Freshness watchdog (§3b) — detects silent instrument death
// ---------------------------------------------------------------------------

export interface FreshnessResult {
  stale: boolean
  lastEventMs: number | null
  ageMs: number | null
  verb: string
}

// Check whether the most recent event for the given verb(s) is within the
// threshold.  If stale and emitIncident=true, an incident event is inserted so
// "instrument went silent" becomes a detectable, queryable event.
export function checkTelemetryFreshness(
  db: Database.Database,
  opts: {
    verb?: string | string[]
    thresholdMs?: number    // default 2h
    emitIncident?: boolean  // default false
    actor?: string          // actor for the incident event
    nowMs?: number
  } = {},
): FreshnessResult {
  const verbs = Array.isArray(opts.verb)
    ? opts.verb
    : [opts.verb ?? 'cost']
  const thresholdMs = opts.thresholdMs ?? 2 * 60 * 60 * 1000
  const nowMs = opts.nowMs ?? Date.now()

  const placeholders = verbs.map(() => '?').join(', ')
  const lastTs = (db.prepare(
    `SELECT MAX(ts) FROM telemetry_event WHERE verb IN (${placeholders})`
  ).pluck().get(...verbs) as number | null)

  const ageMs = lastTs !== null ? nowMs - lastTs : null
  const stale = lastTs === null || ageMs! > thresholdMs

  if (stale && opts.emitIncident) {
    insertTelemetryEvent(db, {
      ts: nowMs,
      actor: opts.actor ?? 'watchdog',
      verb: 'incident',
      object: 'telemetry-freshness',
      status: 'warn',
      meta: {
        anomaly_flag: `stale-${verbs.join(',')}`,
        status_detail: lastTs !== null
          ? `last event ${Math.round(ageMs! / 1000)}s ago`
          : 'no events ever',
      },
    }, nowMs)
  }

  return { stale, lastEventMs: lastTs ?? null, ageMs, verb: verbs.join(',') }
}

// ---------------------------------------------------------------------------
// Series query — reads from telemetry_daily for trend charts (§5 API)
// ---------------------------------------------------------------------------

export interface SeriesRow {
  day: string
  count: number
  weight_sum: number
  tokens_in: number
  tokens_out: number
  cost_usd: number
}

// Query daily aggregates for trending.  metric='session-wake' filters to only
// session-wake verb rows; 'cost'/'tokens' aggregate across all verbs (the
// cost_usd / token columns are already per-verb sums in telemetry_daily).
export function queryTelemetrySeries(
  db: Database.Database,
  opts: {
    metric?: string
    fromDay?: string
    toDay?: string
    actor?: string
    limit?: number
  } = {},
): SeriesRow[] {
  const limit = Math.min(opts.limit ?? 90, 365)
  const clauses: string[] = ['1=1']
  const params: (string | number)[] = []

  if (opts.fromDay) { clauses.push('day >= ?'); params.push(opts.fromDay) }
  if (opts.toDay)   { clauses.push('day <= ?'); params.push(opts.toDay) }
  if (opts.actor)   { clauses.push('actor = ?'); params.push(opts.actor) }
  if (opts.metric === 'session-wake') { clauses.push("verb = 'session-wake'") }

  params.push(limit)

  return db.prepare(`
    SELECT day,
           SUM(count)                     AS count,
           SUM(weight_sum)                AS weight_sum,
           SUM(COALESCE(tokens_in,  0))   AS tokens_in,
           SUM(COALESCE(tokens_out, 0))   AS tokens_out,
           SUM(COALESCE(cost_usd,   0.0)) AS cost_usd
    FROM telemetry_daily
    WHERE ${clauses.join(' AND ')}
    GROUP BY day
    ORDER BY day ASC
    LIMIT ?
  `).all(...params) as SeriesRow[]
}
