import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { migrateKanbanCardsSomeday } from '../db.js'

// Regression guard for the 'someday' (Valamikor) column migration. The live
// failure: the status-CHECK-widening rebuild (CREATE _new / INSERT SELECT /
// DROP / RENAME) ran inside a transaction with foreign_keys ENABLED.
// better-sqlite3 turns foreign_keys ON by default, and kanban_cards carries a
// self-referential FK (parent_id REFERENCES kanban_cards(id)), so the DROP/
// RENAME swap threw "FOREIGN KEY constraint failed". The migration silently
// failed (caught + logged) and the narrow CHECK persisted, so the 'someday'
// column could never receive a card. The fix toggles foreign_keys OFF OUTSIDE
// the transaction (the pragma is a no-op inside one) and re-checks integrity
// with foreign_key_check before COMMIT.

const NARROW_SCHEMA = `
  CREATE TABLE kanban_cards (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','waiting','done')),
    assignee TEXT,
    priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
    project TEXT,
    parent_id TEXT REFERENCES kanban_cards(id),
    due_date INTEGER,
    sort_order REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER,
    dispatched_at INTEGER
  )
`

function insertCard(db: Database.Database, id: string, status: string, parentId: string | null = null): void {
  db.prepare(
    `INSERT INTO kanban_cards (id, title, status, priority, parent_id, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, 'normal', ?, 0, 1, 1)`,
  ).run(id, `card ${id}`, status, parentId)
}

function statusCheckSql(db: Database.Database): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE name='kanban_cards'").get() as { sql: string }
  return row.sql
}

describe('migrateKanbanCardsSomeday', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
  })

  it('runs with foreign_keys ON by default (reproduces the live condition)', () => {
    // The whole bug only manifests because better-sqlite3 enforces FKs by
    // default; assert that here so a future driver change that flips this
    // surfaces as a failing precondition rather than a silently-passing test.
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('widens the status CHECK to include someday despite the self-FK, preserving rows + rowid', () => {
    db.exec(NARROW_SCHEMA)
    insertCard(db, 'p', 'planned')
    insertCard(db, 'c', 'in_progress', 'p') // child -> parent self-FK
    // Create a rowid gap so we prove rowid (the card's display seq) survives.
    insertCard(db, 'gap', 'done')
    db.prepare("DELETE FROM kanban_cards WHERE id='gap'").run()
    const before = db
      .prepare('SELECT rowid, id, status, parent_id FROM kanban_cards ORDER BY rowid')
      .all() as Array<{ rowid: number; id: string; status: string; parent_id: string | null }>

    migrateKanbanCardsSomeday(db)

    // CHECK now admits someday.
    expect(statusCheckSql(db)).toMatch(/'someday'/)
    // All rows + their rowids survived the rebuild.
    const after = db
      .prepare('SELECT rowid, id, status, parent_id FROM kanban_cards ORDER BY rowid')
      .all() as Array<{ rowid: number; id: string; status: string; parent_id: string | null }>
    expect(after).toEqual(before)
    // The child's self-FK reference is intact.
    expect(after.find((r) => r.id === 'c')?.parent_id).toBe('p')
  })

  it('accepts a someday insert after migration (the user-visible payoff)', () => {
    db.exec(NARROW_SCHEMA)
    insertCard(db, 'p', 'planned')

    migrateKanbanCardsSomeday(db)

    expect(() => insertCard(db, 's', 'someday')).not.toThrow()
    const card = db.prepare("SELECT status FROM kanban_cards WHERE id='s'").get() as { status: string }
    expect(card.status).toBe('someday')
    // The narrow statuses still validate, and a bogus status is still rejected.
    expect(() => insertCard(db, 'ok', 'waiting')).not.toThrow()
    expect(() => insertCard(db, 'bad', 'nonsense')).toThrow()
  })

  it('restores foreign_keys enforcement after the rebuild', () => {
    db.exec(NARROW_SCHEMA)
    insertCard(db, 'p', 'planned')

    migrateKanbanCardsSomeday(db)

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    // FK enforcement is live again: a dangling parent_id is now rejected.
    expect(() => insertCard(db, 'orphan', 'planned', 'does-not-exist')).toThrow()
  })

  it('is a no-op on an already-widened schema (idempotent)', () => {
    db.exec(NARROW_SCHEMA)
    insertCard(db, 'p', 'planned')
    migrateKanbanCardsSomeday(db) // first run widens
    const sqlAfterFirst = statusCheckSql(db)
    const rowsAfterFirst = db.prepare('SELECT rowid, id FROM kanban_cards ORDER BY rowid').all()

    migrateKanbanCardsSomeday(db) // second run must do nothing

    expect(statusCheckSql(db)).toBe(sqlAfterFirst)
    expect(db.prepare('SELECT rowid, id FROM kanban_cards ORDER BY rowid').all()).toEqual(rowsAfterFirst)
  })

  it('rolls back and leaves the original table intact if the data has an orphaned FK', () => {
    db.exec(NARROW_SCHEMA)
    // Insert an orphan with FK enforcement off so the bad row exists pre-migration,
    // mirroring a DB that was corrupted before FKs were enforced.
    db.pragma('foreign_keys = OFF')
    insertCard(db, 'orphan', 'planned', 'missing-parent')
    db.pragma('foreign_keys = ON')

    // foreign_key_check inside the rebuild must catch the orphan and abort.
    expect(() => migrateKanbanCardsSomeday(db)).toThrow(/foreign_key_check/i)
    // Original table is untouched: still narrow, orphan row still present.
    expect(statusCheckSql(db)).not.toMatch(/'someday'/)
    expect(db.prepare("SELECT id FROM kanban_cards WHERE id='orphan'").get()).toBeTruthy()
  })
})
