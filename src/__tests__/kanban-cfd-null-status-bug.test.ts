/**
 * Card 44783957 boundary (data-correctness slice): NULL-status card in buildCfdSnapshot.
 *
 * SKIPPED until the SQL is fixed -- kept here to document the bug and pin the
 * fix target. Move from it.skip -> it once Dave lands `WHERE status IS NOT 'icebox'`.
 *
 * Root cause: `WHERE status != 'icebox'` uses `!=`. In SQLite, `NULL != 'icebox'`
 * evaluates to NULL (unknown), so the WHERE clause silently excludes NULL-status rows.
 * A NULL card never reaches the GROUP BY, never lands in `other`, and snap.other stays
 * at 0 when it should be 1 -- an active-card count that reads as lower than reality.
 *
 * Fix: `WHERE status IS NOT 'icebox'`  (SQLite IS NOT is NULL-safe: NULL IS NOT
 * 'icebox' = TRUE, so NULL-status rows pass through and fall into the `other` bucket).
 *
 * Production note: the schema enforces `status NOT NULL DEFAULT 'planned'`, so this
 * path is unreachable via normal INSERT. The SQL is still wrong, and if the constraint
 * is ever relaxed (or an older migration allowed NULL) the silent drop would reappear.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { buildCfdSnapshot } from '../web/routes/kanban-cfd.js'

const MINIMAL_SCHEMA = `
  CREATE TABLE kanban_cards (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT,
    priority TEXT NOT NULL DEFAULT 'normal',
    sort_order REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`

describe('buildCfdSnapshot -- C7a NULL-status boundary (SKIPPED: bug open, fix = IS NOT)', () => {
  it.skip('NULL status card is routed to other, not silently dropped', () => {
    const db = new Database(':memory:')
    db.exec(MINIMAL_SCHEMA)
    db.prepare(
      `INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at)
       VALUES ('a', 'A', NULL, 'normal', 1, 0, 0),
              ('b', 'B', 'planned', 'normal', 2, 0, 0)`
    ).run()

    const snap = buildCfdSnapshot(db)
    expect(snap.other).toBe(1)
    expect(snap.planned).toBe(1)
    const sum = snap.planned + snap.in_progress + snap.waiting + snap.done + snap.other
    expect(sum).toBe(2)
  })

  it.skip('NULL status card with an icebox sibling: icebox excluded, NULL goes to other', () => {
    const db = new Database(':memory:')
    db.exec(MINIMAL_SCHEMA)
    db.prepare(
      `INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at)
       VALUES ('a', 'A', NULL,     'normal', 1, 0, 0),
              ('z', 'Z', 'icebox', 'normal', 2, 0, 0)`
    ).run()

    const snap = buildCfdSnapshot(db)
    expect(snap.other).toBe(1)
    const sum = snap.planned + snap.in_progress + snap.waiting + snap.done + snap.other
    expect(sum).toBe(1)
  })
})
