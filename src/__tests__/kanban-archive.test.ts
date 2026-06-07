import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import {
  initDatabase, getDb, createKanbanCard,
  listKanbanCards, listArchivedKanbanCards, moveKanbanCard,
} from '../db.js'

// Daily auto-archive: the "Kész" column should show only cards completed today
// (local calendar day); done cards last touched before today get auto-archived
// on the next listKanbanCards() read and surface via listArchivedKanbanCards().
const TEST_DB = '/tmp/test-kanban-archive.db'

function setUpdatedAt(id: string, epoch: number): void {
  getDb().prepare('UPDATE kanban_cards SET updated_at = ? WHERE id = ?').run(epoch, id)
}

describe('kanban daily auto-archive', () => {
  beforeEach(() => {
    rmSync(TEST_DB, { force: true })
    initDatabase(TEST_DB)
  })

  afterAll(() => rmSync(TEST_DB, { force: true }))

  it('archives done cards last touched before today, keeps today\'s done', () => {
    const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86400

    createKanbanCard({ id: 'old-done', title: 'finished yesterday', status: 'done' })
    setUpdatedAt('old-done', twoDaysAgo)
    createKanbanCard({ id: 'today-done', title: 'finished today', status: 'done' })
    createKanbanCard({ id: 'planned', title: 'still planned', status: 'planned' })

    const active = listKanbanCards()
    const activeIds = active.map((c) => c.id)
    expect(activeIds).toContain('today-done')
    expect(activeIds).toContain('planned')
    expect(activeIds).not.toContain('old-done')

    const archived = listArchivedKanbanCards()
    const oldArchived = archived.find((c) => c.id === 'old-done')
    expect(oldArchived).toBeDefined()
    expect(oldArchived!.archived_at).not.toBeNull()
  })

  it('does not archive non-done cards even when old', () => {
    const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86400
    createKanbanCard({ id: 'old-waiting', title: 'old but waiting', status: 'waiting' })
    setUpdatedAt('old-waiting', twoDaysAgo)

    const active = listKanbanCards()
    expect(active.map((c) => c.id)).toContain('old-waiting')
    expect(listArchivedKanbanCards().map((c) => c.id)).not.toContain('old-waiting')
  })

  it('accepts the someday status and never auto-archives it, even when old', () => {
    const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86400
    // CHECK constraint must allow 'someday' on insert.
    createKanbanCard({ id: 'old-someday', title: 'far-future idea', status: 'someday' })
    setUpdatedAt('old-someday', twoDaysAgo)

    const active = listKanbanCards()
    expect(active.map((c) => c.id)).toContain('old-someday')
    expect(listArchivedKanbanCards().map((c) => c.id)).not.toContain('old-someday')
  })

  it('allows moving a card to someday (CHECK accepts the status)', () => {
    createKanbanCard({ id: 'to-someday', title: 'defer me', status: 'planned' })
    expect(moveKanbanCard('to-someday', 'someday', 0)).toBe(true)
    const active = listKanbanCards()
    const card = active.find((c) => c.id === 'to-someday')
    expect(card?.status).toBe('someday')
  })
})

// The someday CHECK-widening migration only fires on a DB whose kanban_cards
// was created with the OLD narrow CHECK (a fresh test DB already has the wide
// CHECK, so it never exercises the table-rebuild path). Build a legacy-schema
// DB by hand to drive the rebuild and prove it preserves row identity.
describe('kanban someday migration (legacy-schema rebuild)', () => {
  const LEGACY_DB = '/tmp/test-kanban-legacy.db'
  beforeEach(() => rmSync(LEGACY_DB, { force: true }))
  afterAll(() => rmSync(LEGACY_DB, { force: true }))

  it('preserves rowid/seq across the rebuild (even with rowid gaps) and accepts someday', () => {
    // Seed a DB with the pre-someday schema and a rowid gap (delete the middle).
    const raw = new Database(LEGACY_DB)
    raw.exec(`CREATE TABLE kanban_cards (
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
    )`)
    const now = Math.floor(Date.now() / 1000)
    const ins = raw.prepare('INSERT INTO kanban_cards (id, title, status, sort_order, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
    ins.run('card-a', 'A', 'planned', now, now)  // rowid 1
    ins.run('card-b', 'B', 'planned', now, now)  // rowid 2
    ins.run('card-c', 'C', 'planned', now, now)  // rowid 3
    raw.prepare('DELETE FROM kanban_cards WHERE id = ?').run('card-b')  // gap at rowid 2
    raw.close()

    // Boot the real init -> the someday rebuild migration runs.
    initDatabase(LEGACY_DB)

    // seq is the SQLite rowid; the rebuild must carry it so display numbers are
    // stable. card-c must stay #3, not slide down to #2.
    const cards = listKanbanCards()
    expect(cards.find((c) => c.id === 'card-a')?.seq).toBe(1)
    expect(cards.find((c) => c.id === 'card-c')?.seq).toBe(3)

    // and the widened CHECK now accepts someday.
    createKanbanCard({ id: 'new-someday', title: 'idea', status: 'someday' })
    expect(listKanbanCards().find((c) => c.id === 'new-someday')?.status).toBe('someday')
  })
})
