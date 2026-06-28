/**
 * W3: kanban route wired to noa-kanban.
 * Critical assertions:
 *   - Exactly ONE agent_messages row per in_progress transition (no double-dispatch)
 *   - Dispatch guard holds (dispatched_at one-shot prevents re-fire)
 *   - Error types that routes must catch and map to HTTP codes
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initNoaDb, getNoaDb } from '../noa-memory.js'
import {
  createCard,
  moveCard,
  updateCard,
  deleteCard,
  getChildCards,
  configureKanban,
  invalidateColumnsCache,
  HasActiveChildrenError,
  InvalidTransitionError,
  InvalidStatusError,
  InvalidSortOrderError,
} from '../noa-kanban.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(__dirname, '..', '..', 'scripts', 'schema-noa.sql'), 'utf8')

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initNoaDb(':memory:')
  getNoaDb().exec(SCHEMA_SQL)
  // Inject isRunning so dispatch resolves a target
  configureKanban({
    isRunning: () => true,
    agentNames: ['dave', 'rackham'],
  })
})

function wipe(): void {
  const db = getNoaDb()
  db.prepare('DELETE FROM kanban_comments').run()
  db.prepare('DELETE FROM kanban_cards').run()
  db.prepare('DELETE FROM agent_messages').run()
  db.prepare("DELETE FROM board_columns WHERE id NOT IN ('planned','in_progress','waiting','done','someday')").run()
  invalidateColumnsCache()
}

beforeEach(wipe)
afterEach(wipe)

function messageCount(): number {
  return (getNoaDb().prepare('SELECT COUNT(*) as n FROM agent_messages').get() as { n: number }).n
}

// ---------------------------------------------------------------------------
// Dispatch: exactly ONE agent_messages row per in_progress transition
// ---------------------------------------------------------------------------

describe('W3-dispatch: single agent_messages on in_progress', () => {
  it('moveCard to in_progress fires exactly one dispatch message', () => {
    const card = createCard({ title: 'Task', assignee: 'dave', suppressIntake: true })
    expect(messageCount()).toBe(0)

    moveCard(card.id, 'in_progress', 1)

    expect(messageCount()).toBe(1)
  })

  it('dispatched_at is set after first in_progress move (one-shot guard)', () => {
    const card = createCard({ title: 'Task', assignee: 'dave', suppressIntake: true })
    moveCard(card.id, 'in_progress', 1)

    const row = getNoaDb()
      .prepare('SELECT dispatched_at FROM kanban_cards WHERE id = ?')
      .get(card.id) as { dispatched_at: number | null }
    expect(row.dispatched_at).not.toBeNull()
  })

  it('moving back and then in_progress again does NOT add a second message', () => {
    const card = createCard({ title: 'Task', assignee: 'dave', suppressIntake: true })
    moveCard(card.id, 'in_progress', 1)
    expect(messageCount()).toBe(1)

    // Move back to planned (allowed by state machine) then in_progress again
    moveCard(card.id, 'planned', 1)
    moveCard(card.id, 'in_progress', 1)

    // dispatched_at is set, so the second in_progress does NOT fire a new message
    expect(messageCount()).toBe(1)
  })

  it('card without assignee does not fire a dispatch message', () => {
    const card = createCard({ title: 'Unassigned task', assignee: null, suppressIntake: true })
    moveCard(card.id, 'in_progress', 1)
    expect(messageCount()).toBe(0)
  })

  it('updateCard to in_progress fires exactly one dispatch message', () => {
    const card = createCard({ title: 'Task', assignee: 'rackham', suppressIntake: true })
    expect(messageCount()).toBe(0)

    updateCard(card.id, { status: 'in_progress' })

    expect(messageCount()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Error types: mapped to HTTP codes by routes/kanban.ts
// ---------------------------------------------------------------------------

describe('W3-errors: noa-kanban throws for route to catch', () => {
  it('InvalidTransitionError: someday -> done (route maps to 400)', () => {
    const card = createCard({ title: 'T', status: 'someday', suppressIntake: true })
    expect(() => moveCard(card.id, 'done', 1)).toThrow(InvalidTransitionError)
  })

  it('InvalidStatusError: unknown status (route maps to 400)', () => {
    const card = createCard({ title: 'T', suppressIntake: true })
    expect(() => moveCard(card.id, 'nonexistent', 1)).toThrow(InvalidStatusError)
  })

  it('InvalidSortOrderError: sort_order <= 0 (route catches if passed explicitly)', () => {
    const card = createCard({ title: 'T', suppressIntake: true })
    expect(() => moveCard(card.id, 'in_progress', 0)).toThrow(InvalidSortOrderError)
  })

  it('HasActiveChildrenError: delete card with active child (route maps to 409)', () => {
    const parent = createCard({ title: 'Parent', suppressIntake: true })
    createCard({ title: 'Child', parent_id: parent.id, suppressIntake: true })

    expect(getChildCards(parent.id)).toHaveLength(1)
    expect(() => deleteCard(parent.id)).toThrow(HasActiveChildrenError)
  })

  it('InvalidTransitionError: updateCard with invalid status change (route maps to 400)', () => {
    const card = createCard({ title: 'T', status: 'someday', suppressIntake: true })
    expect(() => updateCard(card.id, { status: 'done' })).toThrow(InvalidTransitionError)
  })
})

// ---------------------------------------------------------------------------
// sort_order default: route must not pass 0 to moveCard
// ---------------------------------------------------------------------------

describe('W3-sort_order: default 1 when omitted', () => {
  it('moveCard with sort_order=1 (route default) succeeds', () => {
    const card = createCard({ title: 'T', suppressIntake: true })
    expect(() => moveCard(card.id, 'in_progress', 1)).not.toThrow()
  })
})
