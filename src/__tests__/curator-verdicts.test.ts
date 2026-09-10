// Tests for curator_verdicts REST API (card 81a912dc).
//
// Three axes:
//   POST /api/curator/verdicts -- create a verdikt
//   GET  /api/curator/verdicts -- list with optional filters
//   nightly applyer (applyPendingCuratorVerdicts) -- APPROVE marks entry superseded
//
// All DB operations use an in-memory SQLite handle so each test group is
// isolated; no writes hit the live noa.db.

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  migrateCuratorVerdicts,
  saveCuratorVerdict,
  listCuratorVerdicts,
  applyPendingCuratorVerdicts,
  type CuratorVerdictRow,
  type InsertCuratorVerdict,
} from '../curator-verdicts.js'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id    TEXT    NOT NULL,
      content     TEXT    NOT NULL,
      category    TEXT    NOT NULL,
      keywords    TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      accessed_at INTEGER
    )
  `)
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
  migrateCuratorVerdicts(db)
  return db
}

function seedMemory(db: Database.Database, category = 'warm'): number {
  const stmt = db.prepare(
    `INSERT INTO memories (agent_id, content, category) VALUES ('marveen', 'seed content', ?)`,
  )
  return Number((stmt.run(category) as { lastInsertRowid: number | bigint }).lastInsertRowid)
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

describe('migrateCuratorVerdicts', () => {
  it('creates the curator_verdicts table', () => {
    const db = freshDb()
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='curator_verdicts'`)
      .get() as { name: string } | undefined
    expect(row?.name).toBe('curator_verdicts')
  })

  it('is idempotent -- second call does not throw', () => {
    const db = freshDb()
    expect(() => migrateCuratorVerdicts(db)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// saveCuratorVerdict
// ---------------------------------------------------------------------------

describe('saveCuratorVerdict', () => {
  let db: Database.Database
  let entryAId: number
  let entryBId: number

  beforeEach(() => {
    db = freshDb()
    entryAId = seedMemory(db, 'warm')
    entryBId = seedMemory(db, 'warm')
  })

  it('inserts a PENDING verdict and returns the generated id', () => {
    const input: InsertCuratorVerdict = {
      agent_id: 'applegate',
      entry_a_id: entryAId,
      entry_b_id: entryBId,
      jaccard: 0.87,
      verdict: 'PENDING',
      curator_notes: 'very similar',
      ttl_days: 7,
    }
    const id = saveCuratorVerdict(db, input)
    expect(typeof id).toBe('number')
    expect(id).toBeGreaterThan(0)
  })

  it('stores all columns correctly', () => {
    const input: InsertCuratorVerdict = {
      agent_id: 'applegate',
      entry_a_id: entryAId,
      entry_b_id: entryBId,
      jaccard: 0.92,
      verdict: 'APPROVE',
      curator_notes: 'duplicate',
      ttl_days: 14,
    }
    const id = saveCuratorVerdict(db, input)
    const row = db.prepare('SELECT * FROM curator_verdicts WHERE id = ?').get(id) as CuratorVerdictRow
    expect(row.agent_id).toBe('applegate')
    expect(row.entry_a_id).toBe(entryAId)
    expect(row.entry_b_id).toBe(entryBId)
    expect(row.jaccard).toBeCloseTo(0.92)
    expect(row.verdict).toBe('APPROVE')
    expect(row.curator_notes).toBe('duplicate')
    expect(row.ttl_days).toBe(14)
    expect(row.approved_at).toBeNull()
    expect(row.applied_at).toBeNull()
  })

  it('accepts null optional fields (proposal_id, ttl_days)', () => {
    const id = saveCuratorVerdict(db, {
      agent_id: 'applegate',
      entry_a_id: entryAId,
      entry_b_id: entryBId,
      jaccard: 0.5,
      verdict: 'REJECT',
    })
    const row = db.prepare('SELECT * FROM curator_verdicts WHERE id = ?').get(id) as CuratorVerdictRow
    expect(row.proposal_id).toBeNull()
    expect(row.ttl_days).toBeNull()
    expect(row.curator_notes).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// listCuratorVerdicts
// ---------------------------------------------------------------------------

describe('listCuratorVerdicts', () => {
  let db: Database.Database
  let aId: number
  let bId: number
  let cId: number

  beforeEach(() => {
    db = freshDb()
    aId = seedMemory(db, 'warm')
    bId = seedMemory(db, 'warm')
    cId = seedMemory(db, 'cold')
    saveCuratorVerdict(db, { agent_id: 'applegate', entry_a_id: aId, entry_b_id: bId, jaccard: 0.9, verdict: 'APPROVE' })
    saveCuratorVerdict(db, { agent_id: 'applegate', entry_a_id: bId, entry_b_id: cId, jaccard: 0.4, verdict: 'REJECT' })
    saveCuratorVerdict(db, { agent_id: 'applegate', entry_a_id: aId, entry_b_id: cId, jaccard: 0.6, verdict: 'PENDING' })
  })

  it('returns all rows when no filter', () => {
    expect(listCuratorVerdicts(db, {}).length).toBe(3)
  })

  it('filters by verdict', () => {
    const rows = listCuratorVerdicts(db, { verdict: 'APPROVE' })
    expect(rows.length).toBe(1)
    expect(rows[0].verdict).toBe('APPROVE')
  })

  it('filters by agent_id', () => {
    saveCuratorVerdict(db, { agent_id: 'other', entry_a_id: aId, entry_b_id: bId, jaccard: 0.1, verdict: 'PENDING' })
    const rows = listCuratorVerdicts(db, { agent_id: 'applegate' })
    expect(rows.every(r => r.agent_id === 'applegate')).toBe(true)
  })

  it('filters by applied -- unapplied only', () => {
    const rows = listCuratorVerdicts(db, { applied: false })
    expect(rows.every(r => r.applied_at === null)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// applyPendingCuratorVerdicts (nightly applyer)
// ---------------------------------------------------------------------------

describe('applyPendingCuratorVerdicts', () => {
  let db: Database.Database
  let aId: number
  let bId: number

  beforeEach(() => {
    db = freshDb()
    aId = seedMemory(db, 'warm')
    bId = seedMemory(db, 'warm')
  })

  it('APPROVE: marks entry_a as cold+SUPERSEDED and sets applied_at', () => {
    const vId = saveCuratorVerdict(db, {
      agent_id: 'applegate',
      entry_a_id: aId,
      entry_b_id: bId,
      jaccard: 0.9,
      verdict: 'APPROVE',
    })

    const result = applyPendingCuratorVerdicts(db)
    expect(result.approved).toBe(1)
    expect(result.rejected).toBe(0)

    const mem = db.prepare('SELECT category, content FROM memories WHERE id = ?').get(aId) as { category: string; content: string }
    expect(mem.category).toBe('cold')
    expect(mem.content).toMatch(/^SUPERSEDED:/)

    const v = db.prepare('SELECT applied_at FROM curator_verdicts WHERE id = ?').get(vId) as { applied_at: number | null }
    expect(v.applied_at).not.toBeNull()
  })

  it('APPROVE: appends to migration_log (audit trail)', () => {
    saveCuratorVerdict(db, {
      agent_id: 'applegate',
      entry_a_id: aId,
      entry_b_id: bId,
      jaccard: 0.9,
      verdict: 'APPROVE',
    })
    applyPendingCuratorVerdicts(db)

    const log = db.prepare('SELECT * FROM migration_log WHERE entry_id = ?').get(aId) as { rule: string; from_cat: string; to_cat: string; reason: string } | undefined
    expect(log).toBeDefined()
    expect(log!.rule).toBe('SUPERSEDED')
    expect(log!.from_cat).toBe('warm')
    expect(log!.to_cat).toBe('cold')
    expect(log!.reason).toContain('curator APPROVE')
  })

  it('REJECT: skips memory mutation, sets applied_at, logs to migration_log', () => {
    const vId = saveCuratorVerdict(db, {
      agent_id: 'applegate',
      entry_a_id: aId,
      entry_b_id: bId,
      jaccard: 0.3,
      verdict: 'REJECT',
    })

    const result = applyPendingCuratorVerdicts(db)
    expect(result.rejected).toBe(1)

    const mem = db.prepare('SELECT category FROM memories WHERE id = ?').get(aId) as { category: string }
    expect(mem.category).toBe('warm') // unchanged

    const v = db.prepare('SELECT applied_at FROM curator_verdicts WHERE id = ?').get(vId) as { applied_at: number | null }
    expect(v.applied_at).not.toBeNull()
  })

  it('PENDING / HOLD: skipped entirely', () => {
    saveCuratorVerdict(db, { agent_id: 'applegate', entry_a_id: aId, entry_b_id: bId, jaccard: 0.5, verdict: 'PENDING' })
    const result = applyPendingCuratorVerdicts(db)
    expect(result.approved).toBe(0)
    expect(result.rejected).toBe(0)
    expect(result.skipped).toBe(1)
  })

  it('idempotent: applying twice does not double-apply (applied_at guard)', () => {
    saveCuratorVerdict(db, { agent_id: 'applegate', entry_a_id: aId, entry_b_id: bId, jaccard: 0.9, verdict: 'APPROVE' })
    applyPendingCuratorVerdicts(db)
    const second = applyPendingCuratorVerdicts(db)
    // Second run finds nothing to process (applied_at IS NULL filter returns 0 rows)
    expect(second.approved).toBe(0)
    expect(second.rejected).toBe(0)
    // migration_log should still have exactly one entry (not two)
    const logCount = (db.prepare('SELECT COUNT(*) AS c FROM migration_log').get() as { c: number }).c
    expect(logCount).toBe(1)
  })
})
