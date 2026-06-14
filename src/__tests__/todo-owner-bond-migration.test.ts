import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { migrateTodoOwnerBond } from '../db.js'

// Regression guard for the todo_items owner-CHECK widening migration (card
// 2f7cd951: add 'bond' as a third To-Do owner). The live trap, documented in
// db.ts above the CREATE: widening a CHECK after the table exists silently
// fails because CREATE TABLE IF NOT EXISTS no-ops on the existing table, so the
// narrow CHECK(owner IN ('claudia','hibiki')) persists and an owner='bond'
// write 400s forever. The fix is a table-rebuild migration (CREATE _new /
// INSERT SELECT / DROP / RENAME) modelled on migrateKanbanCardsSomeday:
// atomic, idempotent, foreign_keys toggled OFF outside the transaction, and a
// row-count assert before COMMIT. todo_items carries no FK today; we still
// follow the canonical recipe defensively.

const NARROW_SCHEMA = `
  CREATE TABLE todo_items (
    id            TEXT PRIMARY KEY,
    owner         TEXT NOT NULL CHECK(owner IN ('claudia','hibiki')),
    section       TEXT CHECK(section IN ('general','learning','fitness')),
    kind          TEXT CHECK(kind IN ('task','habit','metric','progress')),
    title         TEXT NOT NULL,
    detail        TEXT,
    done          INTEGER NOT NULL DEFAULT 0,
    status        TEXT,
    target_val    REAL,
    actual_val    REAL,
    sort_order    REAL,
    last_progress_at INTEGER,
    progress_note TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    done_at       INTEGER
  );
  CREATE INDEX idx_todo_owner ON todo_items(owner, created_at);
`

function insertTodo(
  db: Database.Database,
  id: string,
  owner: string,
  section: string | null = null,
  kind: string = 'task',
): void {
  db.prepare(
    `INSERT INTO todo_items (id, owner, section, kind, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 1)`,
  ).run(id, owner, section, kind, `todo ${id}`)
}

function ownerCheckSql(db: Database.Database): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE name='todo_items'").get() as { sql: string }
  return row.sql
}

function indexNames(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='todo_items'")
      .all() as Array<{ name: string }>
  ).map((r) => r.name)
}

describe('migrateTodoOwnerBond', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
  })

  it('widens the owner CHECK to include bond, preserving rows + rowid', () => {
    db.exec(NARROW_SCHEMA)
    insertTodo(db, 'c1', 'claudia', 'general')
    insertTodo(db, 'h1', 'hibiki', 'fitness', 'metric')
    insertTodo(db, 'l1', 'claudia', 'learning', 'progress')
    // Create a rowid gap so we prove rowid survives the rebuild.
    insertTodo(db, 'gap', 'hibiki')
    db.prepare("DELETE FROM todo_items WHERE id='gap'").run()
    const before = db
      .prepare('SELECT rowid, id, owner, section, kind FROM todo_items ORDER BY rowid')
      .all()

    migrateTodoOwnerBond(db)

    expect(ownerCheckSql(db)).toMatch(/'bond'/)
    const after = db
      .prepare('SELECT rowid, id, owner, section, kind FROM todo_items ORDER BY rowid')
      .all()
    expect(after).toEqual(before)
  })

  it('accepts a bond insert after migration (the user-visible payoff)', () => {
    db.exec(NARROW_SCHEMA)
    insertTodo(db, 'c1', 'claudia')

    migrateTodoOwnerBond(db)

    expect(() => insertTodo(db, 'b1', 'bond', 'learning', 'progress')).not.toThrow()
    const row = db.prepare("SELECT owner, section FROM todo_items WHERE id='b1'").get() as {
      owner: string
      section: string
    }
    expect(row.owner).toBe('bond')
    expect(row.section).toBe('learning')
    // Existing owners still validate; a bogus owner is still rejected.
    expect(() => insertTodo(db, 'c2', 'claudia')).not.toThrow()
    expect(() => insertTodo(db, 'h2', 'hibiki')).not.toThrow()
    expect(() => insertTodo(db, 'x', 'nobody')).toThrow()
  })

  it('recreates idx_todo_owner after the rebuild (schema parity)', () => {
    db.exec(NARROW_SCHEMA)
    insertTodo(db, 'c1', 'claudia')

    migrateTodoOwnerBond(db)

    expect(indexNames(db)).toContain('idx_todo_owner')
  })

  it('restores foreign_keys enforcement after the rebuild', () => {
    db.exec(NARROW_SCHEMA)
    insertTodo(db, 'c1', 'claudia')

    migrateTodoOwnerBond(db)

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('preserves every row across the rebuild (row-count parity)', () => {
    db.exec(NARROW_SCHEMA)
    for (let i = 0; i < 25; i++) {
      insertTodo(db, `c${i}`, i % 2 === 0 ? 'claudia' : 'hibiki', 'general')
    }
    const countBefore = (db.prepare('SELECT COUNT(*) AS c FROM todo_items').get() as { c: number }).c

    migrateTodoOwnerBond(db)

    const countAfter = (db.prepare('SELECT COUNT(*) AS c FROM todo_items').get() as { c: number }).c
    expect(countAfter).toBe(countBefore)
    expect(countAfter).toBe(25)
  })

  it('is a no-op on an already-widened schema (idempotent)', () => {
    db.exec(NARROW_SCHEMA)
    insertTodo(db, 'c1', 'claudia')
    migrateTodoOwnerBond(db) // first run widens
    const sqlAfterFirst = ownerCheckSql(db)
    const rowsAfterFirst = db.prepare('SELECT rowid, id FROM todo_items ORDER BY rowid').all()

    migrateTodoOwnerBond(db) // second run must do nothing

    expect(ownerCheckSql(db)).toBe(sqlAfterFirst)
    expect(db.prepare('SELECT rowid, id FROM todo_items ORDER BY rowid').all()).toEqual(rowsAfterFirst)
  })

  it('is a no-op when the table does not exist yet (fresh install safety)', () => {
    expect(() => migrateTodoOwnerBond(db)).not.toThrow()
  })
})
