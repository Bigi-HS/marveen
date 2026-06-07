import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { rmSync } from 'node:fs'
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
