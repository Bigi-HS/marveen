/**
 * MEM-008 timestamp unit corruption guard (card aa67106f).
 *
 * kanban_cards.updated_at and last_moved MUST store epoch-seconds (10-digit,
 * < 1e10). One write-path previously emitted epoch-milliseconds (13-digit,
 * > 1e12), corrupting row id=570030c9. This suite:
 *
 *   1. Verifies that applyKanbanMigrations normalises pre-existing ms-timestamp
 *      rows (integer-divide by 1000) for both updated_at and last_moved.
 *   2. Verifies that moveCard / updateCard produce epoch-second timestamps.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initNoaDb, getNoaDb } from '../noa-memory.js'
import {
  applyKanbanMigrations,
  createCard,
  moveCard,
  updateCard,
  getCard,
  invalidateColumnsCache,
  configureKanban,
} from '../noa-kanban.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(__dirname, '..', '..', 'scripts', 'schema-noa.sql'), 'utf8')

// Epoch-seconds boundary: any value >= 1e10 is definitely ms-scale.
const MAX_EPOCH_SEC = 1e10

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initNoaDb(':memory:')
  getNoaDb().exec(SCHEMA_SQL)
  configureKanban({ isRunning: () => false, agentNames: [] })
})

function wipe(): void {
  const db = getNoaDb()
  db.prepare('DELETE FROM kanban_comments').run()
  db.prepare('DELETE FROM kanban_cards').run()
  db.prepare("DELETE FROM board_columns WHERE id NOT IN ('planned','in_progress','waiting','done','icebox')").run()
  invalidateColumnsCache()
}

beforeEach(wipe)
afterEach(wipe)

/** Plant a row with explicit (possibly corrupt) timestamps bypassing the write-path. */
function seedCorrupt(id: string, updatedAt: number, lastMoved: number | null = null): void {
  const now = Math.floor(Date.now() / 1000)
  getNoaDb()
    .prepare(
      `INSERT INTO kanban_cards
        (id, title, description, status, assignee, priority, project, parent_id,
         due_date, sort_order, created_at, updated_at, priority_score, depends_on,
         code, last_moved, parked_until, boss_waiting)
       VALUES (?, ?, '', 'planned', NULL, 'normal', 'ENG', NULL, NULL, 1, ?, ?, 6, NULL, NULL, ?, NULL, 0)`,
    )
    .run(id, `card-${id}`, now, updatedAt, lastMoved)
}

function rawTimestamps(id: string): { updated_at: number; last_moved: number | null } {
  const row = getNoaDb()
    .prepare('SELECT updated_at, last_moved FROM kanban_cards WHERE id = ?')
    .get(id) as { updated_at: number; last_moved: number | null } | undefined
  if (!row) throw new Error(`card ${id} not found`)
  return row
}

// ---------------------------------------------------------------------------
// Suite 1: applyKanbanMigrations normalises ms-timestamp rows
// ---------------------------------------------------------------------------

describe('MEM-008: applyKanbanMigrations ms->sec normalisation', () => {
  it('converts updated_at from epoch-ms to epoch-sec when > 1e12', () => {
    const msTs = Date.now() // 13-digit milliseconds
    seedCorrupt('aa67106f', msTs)

    applyKanbanMigrations()

    const { updated_at } = rawTimestamps('aa67106f')
    expect(updated_at).toBeLessThan(MAX_EPOCH_SEC)
    // Should be close to the original divided by 1000 (within 2 seconds)
    expect(Math.abs(updated_at - Math.floor(msTs / 1000))).toBeLessThanOrEqual(2)
  })

  it('converts last_moved from epoch-ms to epoch-sec when > 1e12', () => {
    const msTs = Date.now()
    const now = Math.floor(Date.now() / 1000)
    seedCorrupt('mem008-lm', now, msTs)

    applyKanbanMigrations()

    const { last_moved } = rawTimestamps('mem008-lm')
    expect(last_moved).not.toBeNull()
    expect(last_moved!).toBeLessThan(MAX_EPOCH_SEC)
    expect(Math.abs(last_moved! - Math.floor(msTs / 1000))).toBeLessThanOrEqual(2)
  })

  it('leaves rows already in epoch-sec untouched', () => {
    const secTs = Math.floor(Date.now() / 1000)
    seedCorrupt('mem008-ok', secTs, secTs)

    applyKanbanMigrations()

    const { updated_at, last_moved } = rawTimestamps('mem008-ok')
    expect(updated_at).toBe(secTs)
    expect(last_moved).toBe(secTs)
  })

  it('leaves last_moved=NULL untouched', () => {
    const secTs = Math.floor(Date.now() / 1000)
    seedCorrupt('mem008-null-lm', secTs, null)

    applyKanbanMigrations()

    const { last_moved } = rawTimestamps('mem008-null-lm')
    expect(last_moved).toBeNull()
  })

  it('is idempotent -- a second run does not further corrupt the value', () => {
    const msTs = Date.now()
    seedCorrupt('mem008-idem', msTs)

    applyKanbanMigrations()
    const { updated_at: first } = rawTimestamps('mem008-idem')
    applyKanbanMigrations()
    const { updated_at: second } = rawTimestamps('mem008-idem')

    expect(first).toBe(second)
    expect(second).toBeLessThan(MAX_EPOCH_SEC)
  })
})

// ---------------------------------------------------------------------------
// Suite 2: write-paths emit epoch-seconds
// ---------------------------------------------------------------------------

describe('MEM-008: write-paths produce epoch-sec timestamps', () => {
  it('createCard sets updated_at in epoch-seconds', () => {
    const before = Math.floor(Date.now() / 1000)
    const card = createCard({ title: 'ts-guard-create', project: 'ENG', suppressIntake: true })
    const after = Math.floor(Date.now() / 1000)

    expect(card.updated_at).toBeGreaterThanOrEqual(before)
    expect(card.updated_at).toBeLessThanOrEqual(after)
    expect(card.updated_at).toBeLessThan(MAX_EPOCH_SEC)
  })

  it('moveCard sets updated_at and last_moved in epoch-seconds', () => {
    const card = createCard({ title: 'ts-guard-move', project: 'ENG', suppressIntake: true })
    const before = Math.floor(Date.now() / 1000)
    moveCard(card.id, 'in_progress', 1)
    const after = Math.floor(Date.now() / 1000)

    const moved = getCard(card.id)!
    expect(moved.updated_at).toBeGreaterThanOrEqual(before)
    expect(moved.updated_at).toBeLessThanOrEqual(after)
    expect(moved.updated_at).toBeLessThan(MAX_EPOCH_SEC)

    expect(moved.last_moved).not.toBeNull()
    expect(moved.last_moved!).toBeGreaterThanOrEqual(before)
    expect(moved.last_moved!).toBeLessThanOrEqual(after)
    expect(moved.last_moved!).toBeLessThan(MAX_EPOCH_SEC)
  })

  it('updateCard with status change sets updated_at in epoch-seconds', () => {
    const card = createCard({ title: 'ts-guard-update', project: 'ENG', suppressIntake: true })
    const before = Math.floor(Date.now() / 1000)
    updateCard(card.id, { status: 'in_progress', suppressIntake: true })
    const after = Math.floor(Date.now() / 1000)

    const updated = getCard(card.id)!
    expect(updated.updated_at).toBeGreaterThanOrEqual(before)
    expect(updated.updated_at).toBeLessThanOrEqual(after)
    expect(updated.updated_at).toBeLessThan(MAX_EPOCH_SEC)
  })
})
