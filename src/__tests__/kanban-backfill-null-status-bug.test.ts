/**
 * Card aad1dc7e (sibling of card 8d844f89 / PR#709): NULL-status card in the
 * applyKanbanMigrations priority_score backfill.
 *
 * Root cause: the backfill query used `WHERE priority_score IS NULL AND
 * status != 'icebox' AND archived_at IS NULL`. In SQLite `NULL != 'icebox'`
 * evaluates to NULL (unknown), so a NULL-status card is silently excluded from
 * the backfill: it keeps priority_score NULL and stays out of the board ordering
 * (invisible in the sorted board) even though it is not parked.
 *
 * Fix: `status IS NOT 'icebox'` (NULL-safe: NULL IS NOT 'icebox' = TRUE), so a
 * NULL-status card is treated as active/non-parked and gets a bucket-centre
 * score. Mirrors the buildCfdSnapshot fix in PR#709 (same NULL-safety class).
 *
 * Production note: the live schema enforces `status NOT NULL DEFAULT 'planned'`,
 * so this path is unreachable via normal INSERT today. The SQL is still wrong,
 * and if the constraint is ever relaxed (or an older migration allowed NULL) the
 * silent skip would reappear. This is a regression guard for that.
 *
 * The backfill lives inside applyKanbanMigrations, which only ALTERs an existing
 * kanban_cards table (KANBAN_MIGRATIONS has no CREATE). So we pre-create a
 * minimal table with a NULLABLE status column and run the migration against it;
 * the migration steps that touch absent tables/columns (board_columns, project)
 * are swallowed by their own try/catch, leaving the backfill under test.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { applyKanbanMigrations } from '../noa-kanban.js'

// status is deliberately NULLABLE here to exercise the NULL path the live
// (NOT NULL) schema forbids. priority_score + archived_at exist up front because
// the backfill's WHERE clause reads them and KANBAN_MIGRATIONS does not add
// archived_at (the ALTER that adds priority_score just no-ops as a duplicate).
const MINIMAL_SCHEMA = `
  CREATE TABLE kanban_cards (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT,
    priority TEXT NOT NULL DEFAULT 'normal',
    sort_order REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    priority_score INTEGER,
    archived_at INTEGER
  )
`

function scoreOf(db: Database.Database, id: string): number | null {
  return (db.prepare('SELECT priority_score AS s FROM kanban_cards WHERE id = ?').get(id) as { s: number | null }).s
}

describe('applyKanbanMigrations priority_score backfill -- NULL-status boundary (NULL-safe)', () => {
  it('backfills a bucket-centre score for a NULL-status card (not silently skipped)', () => {
    const db = new Database(':memory:')
    db.exec(MINIMAL_SCHEMA)
    db.prepare(
      `INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at, priority_score, archived_at)
       VALUES ('n', 'NullStatus', NULL, 'high', 1, 0, 0, NULL, NULL)`
    ).run()

    applyKanbanMigrations(db)

    // high centre = 4. A NULL status is not the parked (icebox) lane, so the card
    // is active and must get a score instead of staying NULL and unorderable.
    expect(scoreOf(db, 'n')).toBe(4)
  })

  it('still leaves a parked (icebox) card unscored', () => {
    const db = new Database(':memory:')
    db.exec(MINIMAL_SCHEMA)
    db.prepare(
      `INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at, priority_score, archived_at)
       VALUES ('p', 'Parked', 'icebox', 'high', 1, 0, 0, NULL, NULL)`
    ).run()

    applyKanbanMigrations(db)

    expect(scoreOf(db, 'p')).toBeNull()
  })

  it('backfills a NULL-status card while leaving its icebox sibling unscored', () => {
    const db = new Database(':memory:')
    db.exec(MINIMAL_SCHEMA)
    db.prepare(
      `INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at, priority_score, archived_at)
       VALUES ('n', 'NullStatus', NULL,     'normal', 1, 0, 0, NULL, NULL),
              ('p', 'Parked',     'icebox', 'normal', 2, 0, 0, NULL, NULL)`
    ).run()

    applyKanbanMigrations(db)

    expect(scoreOf(db, 'n')).toBe(6) // normal centre
    expect(scoreOf(db, 'p')).toBeNull()
  })
})
