// Curator-verdikt persistence layer (card 81a912dc).
//
// curator_verdicts: proposals from the vault-lint / applegate curator to merge
// or supersede duplicate memory entries. The nightly applyer (applyPendingCuratorVerdicts)
// processes APPROVE verdicts by demoting entry_a to cold+SUPERSEDED and appends
// to the append-only migration_log audit trail.
//
// Schema mirrors the skill spec (vault-curator-apply-verdicts):
//   id, proposal_id, agent_id, entry_a_id, entry_b_id, jaccard, verdict,
//   curator_notes, approved_at, ttl_days, created_at, applied_at
//
// Additive migration: CREATE TABLE IF NOT EXISTS + indexes. Never rebuilds an
// existing table, no FK -> safe on every boot.

import type Database from 'better-sqlite3'

export interface CuratorVerdictRow {
  id: number
  proposal_id: string | null
  agent_id: string
  entry_a_id: number
  entry_b_id: number
  jaccard: number
  verdict: string
  curator_notes: string | null
  approved_at: number | null
  ttl_days: number | null
  created_at: number
  applied_at: number | null
}

export interface InsertCuratorVerdict {
  proposal_id?: string | null
  agent_id: string
  entry_a_id: number
  entry_b_id: number
  jaccard: number
  verdict: string
  curator_notes?: string | null
  approved_at?: number | null
  ttl_days?: number | null
}

export interface ListCuratorVerdictsFilter {
  verdict?: string
  agent_id?: string
  /** true = only applied; false = only unapplied; undefined = all */
  applied?: boolean
}

export interface ApplyResult {
  approved: number
  rejected: number
  skipped: number
}

// Additive, idempotent, never-break-boot.
export function migrateCuratorVerdicts(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS curator_verdicts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id   TEXT,
      agent_id      TEXT    NOT NULL,
      entry_a_id    INTEGER NOT NULL,
      entry_b_id    INTEGER NOT NULL,
      jaccard       REAL    NOT NULL,
      verdict       TEXT    NOT NULL,
      curator_notes TEXT,
      approved_at   INTEGER,
      ttl_days      INTEGER,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      applied_at    INTEGER
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_curator_verdicts_verdict ON curator_verdicts(verdict, applied_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_curator_verdicts_agent ON curator_verdicts(agent_id, created_at)`)

  // migration_log: append-only audit trail for APPROVE/REJECT applications.
  // Lives here because applyPendingCuratorVerdicts is its sole writer; no other
  // subsystem references this table, so it is natural to co-locate with the
  // curator_verdicts migration.
  db.exec(`
    CREATE TABLE IF NOT EXISTS migration_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      rule       TEXT    NOT NULL,
      entry_id   INTEGER NOT NULL,
      from_cat   TEXT    NOT NULL,
      to_cat     TEXT    NOT NULL,
      reason     TEXT    NOT NULL,
      applier    TEXT    NOT NULL DEFAULT 'curator-applyer',
      applied_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_migration_log_entry ON migration_log(entry_id, applied_at)`)
}

export function saveCuratorVerdict(db: Database.Database, input: InsertCuratorVerdict): number {
  const stmt = db.prepare(`
    INSERT INTO curator_verdicts
      (proposal_id, agent_id, entry_a_id, entry_b_id, jaccard, verdict, curator_notes, approved_at, ttl_days)
    VALUES
      (@proposal_id, @agent_id, @entry_a_id, @entry_b_id, @jaccard, @verdict, @curator_notes, @approved_at, @ttl_days)
  `)
  const result = stmt.run({
    proposal_id: input.proposal_id ?? null,
    agent_id: input.agent_id,
    entry_a_id: input.entry_a_id,
    entry_b_id: input.entry_b_id,
    jaccard: input.jaccard,
    verdict: input.verdict,
    curator_notes: input.curator_notes ?? null,
    approved_at: input.approved_at ?? null,
    ttl_days: input.ttl_days ?? null,
  }) as { lastInsertRowid: number | bigint }
  return Number(result.lastInsertRowid)
}

export function listCuratorVerdicts(
  db: Database.Database,
  filter: ListCuratorVerdictsFilter,
): CuratorVerdictRow[] {
  const conditions: string[] = []
  const params: Record<string, unknown> = {}

  if (filter.verdict !== undefined) {
    conditions.push('verdict = @verdict')
    params.verdict = filter.verdict
  }
  if (filter.agent_id !== undefined) {
    conditions.push('agent_id = @agent_id')
    params.agent_id = filter.agent_id
  }
  if (filter.applied === true) {
    conditions.push('applied_at IS NOT NULL')
  } else if (filter.applied === false) {
    conditions.push('applied_at IS NULL')
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  return db.prepare(`SELECT * FROM curator_verdicts ${where} ORDER BY created_at DESC`).all(params) as CuratorVerdictRow[]
}

// Nightly applyer: processes APPROVE and REJECT verdicts that have not yet
// been applied (applied_at IS NULL). PENDING and already-applied rows are
// counted as skipped.
//
// APPROVE: demote entry_a to cold, prepend 'SUPERSEDED:' to its content,
//          append migration_log row, mark verdict applied.
// REJECT:  append migration_log row (reason='curator REJECT'), mark applied.
//          No memory mutation.
export function applyPendingCuratorVerdicts(db: Database.Database): ApplyResult {
  const result: ApplyResult = { approved: 0, rejected: 0, skipped: 0 }
  const now = Math.floor(Date.now() / 1000)

  const rows = db
    .prepare(`SELECT * FROM curator_verdicts WHERE applied_at IS NULL ORDER BY created_at ASC`)
    .all() as CuratorVerdictRow[]

  const apply = db.transaction((row: CuratorVerdictRow) => {
    if (row.verdict === 'APPROVE') {
      const mem = db
        .prepare('SELECT category, content FROM memories WHERE id = ?')
        .get(row.entry_a_id) as { category: string; content: string } | undefined

      if (mem) {
        db.prepare(
          `UPDATE memories SET category = 'cold', content = 'SUPERSEDED: ' || SUBSTR(content, 1, 200), accessed_at = ? WHERE id = ?`,
        ).run(now, row.entry_a_id)

        db.prepare(
          `INSERT INTO migration_log (rule, entry_id, from_cat, to_cat, reason, applier, applied_at)
           VALUES ('SUPERSEDED', ?, ?, 'cold', 'curator APPROVE', 'curator-applyer', ?)`,
        ).run(row.entry_a_id, mem.category, now)
      }

      db.prepare(`UPDATE curator_verdicts SET applied_at = ? WHERE id = ?`).run(now, row.id)
      result.approved++
    } else if (row.verdict === 'REJECT') {
      const mem = db
        .prepare('SELECT category FROM memories WHERE id = ?')
        .get(row.entry_a_id) as { category: string } | undefined

      db.prepare(
        `INSERT INTO migration_log (rule, entry_id, from_cat, to_cat, reason, applier, applied_at)
         VALUES ('REJECTED', ?, ?, ?, 'curator REJECT', 'curator-applyer', ?)`,
      ).run(row.entry_a_id, mem?.category ?? 'unknown', mem?.category ?? 'unknown', now)

      db.prepare(`UPDATE curator_verdicts SET applied_at = ? WHERE id = ?`).run(now, row.id)
      result.rejected++
    } else {
      // PENDING, HOLD, or any future status -- skip
      result.skipped++
    }
  })

  for (const row of rows) {
    apply(row)
  }

  return result
}
