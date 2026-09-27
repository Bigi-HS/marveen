/**
 * Card 32fd645b (3rd NULL-safety sibling of PR#709 / PR#710): NULL-status child
 * in checkAllChildrenDone.
 *
 * Root cause: the active-children count used `WHERE parent_id = ? AND status !=
 * 'done' AND archived_at IS NULL`. In SQLite `NULL != 'done'` evaluates to NULL
 * (unknown), so a NULL-status (not-done) child is silently dropped from the
 * count. If every OTHER child is done, `active` reads 0 and the parent FALSELY
 * emits `children_all_done` -- a malformed, not-done child treated as done
 * (fail-OPEN).
 *
 * Fix: `status IS NOT 'done'` (NULL-safe: NULL IS NOT 'done' = TRUE), so a
 * NULL-status child counts as active and blocks the false all-done signal
 * (fail-closed). Same class as buildCfdSnapshot (#709) and the priority_score
 * backfill (#710).
 *
 * Production note: kanban_cards.status is NOT NULL DEFAULT 'planned', so this is
 * unreachable via the public API. checkAllChildrenDone is therefore exported and
 * db-injectable, and this guard drives it directly against a minimal nullable
 * schema with a raw NULL-status insert.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { checkAllChildrenDone } from '../noa-kanban.js'
import { subscribeDashboardEvents, type DashboardEvent } from '../event-bus.js'

const MINIMAL_SCHEMA = `
  CREATE TABLE kanban_cards (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    title TEXT NOT NULL,
    status TEXT,
    sort_order REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER
  )
`

function seedChild(db: Database.Database, id: string, parentId: string, status: string | null): void {
  db.prepare(
    `INSERT INTO kanban_cards (id, parent_id, title, status, sort_order, created_at, updated_at, archived_at)
     VALUES (?, ?, ?, ?, 1, 0, 0, NULL)`
  ).run(id, parentId, id, status)
}

function captureAllDone(fn: () => void): DashboardEvent[] {
  const received: DashboardEvent[] = []
  const off = subscribeDashboardEvents((e) => received.push(e))
  try { fn() } finally { off() }
  return received.filter((e) => e.type === 'kanban' && e.action === 'children_all_done')
}

describe('checkAllChildrenDone -- NULL-status child boundary (NULL-safe)', () => {
  it('does NOT emit children_all_done when a not-done child has a NULL status', () => {
    const db = new Database(':memory:')
    db.exec(MINIMAL_SCHEMA)
    seedChild(db, 'c1', 'p', 'done')
    seedChild(db, 'c2', 'p', null) // malformed, not done -> must block the signal

    const allDone = captureAllDone(() => checkAllChildrenDone('p', db))
    expect(allDone).toHaveLength(0)
  })

  it('emits children_all_done when every child really is done (positive control)', () => {
    const db = new Database(':memory:')
    db.exec(MINIMAL_SCHEMA)
    seedChild(db, 'c1', 'p', 'done')
    seedChild(db, 'c2', 'p', 'done')

    const allDone = captureAllDone(() => checkAllChildrenDone('p', db))
    expect(allDone).toHaveLength(1)
    expect(allDone[0].id).toBe('p')
  })

  it('does NOT emit when a normal not-done child remains (regression sanity)', () => {
    const db = new Database(':memory:')
    db.exec(MINIMAL_SCHEMA)
    seedChild(db, 'c1', 'p', 'done')
    seedChild(db, 'c2', 'p', 'in_progress')

    const allDone = captureAllDone(() => checkAllChildrenDone('p', db))
    expect(allDone).toHaveLength(0)
  })
})
