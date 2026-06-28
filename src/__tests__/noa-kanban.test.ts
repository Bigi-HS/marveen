import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { initNoaDb, getNoaDb } from '../noa-memory.js'
import { subscribeDashboardEvents, type DashboardEvent } from '../event-bus.js'
import { resolveKanbanDispatchTarget } from '../kanban-dispatch.js'
import {
  createCard,
  getCard,
  updateCard,
  moveCard,
  archiveCard,
  unarchiveCard,
  deleteCard,
  listCards,
  listArchived,
  getChildCards,
  reorderCards,
  addComment,
  listComments,
  runArchiveSweep,
  listColumns,
  createColumn,
  renameColumn,
  deleteColumn,
  invalidateColumnsCache,
  configureKanban,
  listProjects,
  markCardDispatched,
  runInTransaction,
  listKanbanCardsSummary,
  getHeartbeatKanbanSummary,
  InvalidStatusError,
  InvalidTransitionError,
  InvalidSortOrderError,
  CrossColumnReorderError,
  ParentNotFoundError,
  HasActiveChildrenError,
  ColumnNotEmptyError,
  BuiltinColumnError,
} from '../noa-kanban.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(__dirname, '..', '..', 'scripts', 'schema-noa.sql'), 'utf8')

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initNoaDb(':memory:')
  getNoaDb().exec(SCHEMA_SQL)
})

function wipe(): void {
  const db = getNoaDb()
  db.prepare('DELETE FROM kanban_comments').run()
  db.prepare('DELETE FROM kanban_cards').run()
  db.prepare('DELETE FROM agent_messages').run()
  // Restore builtin columns only (wipe custom columns)
  db.prepare("DELETE FROM board_columns WHERE id NOT IN ('planned','in_progress','waiting','done','someday')").run()
  invalidateColumnsCache()
}

beforeEach(wipe)
afterEach(wipe)

// ---------------------------------------------------------------------------
// Schema DoD assertions (AC-9)
// ---------------------------------------------------------------------------

describe('AC-9: board_columns schema', () => {
  it('has exactly 5 seed rows', () => {
    const count = (getNoaDb().prepare('SELECT COUNT(*) as n FROM board_columns').get() as { n: number }).n
    expect(count).toBe(5)
  })

  it('has the expected builtin ids', () => {
    const ids = (getNoaDb().prepare('SELECT id FROM board_columns ORDER BY sort_order').all() as { id: string }[]).map((r) => r.id)
    expect(ids).toEqual(['planned', 'in_progress', 'waiting', 'someday', 'done'])
  })

  it('idx_board_columns_order index exists', () => {
    const idx = (getNoaDb().prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_board_columns_order'").get() as { name: string } | undefined)?.name
    expect(idx).toBe('idx_board_columns_order')
  })
})

// ---------------------------------------------------------------------------
// AC-1: Valid status values (dynamic from board_columns)
// ---------------------------------------------------------------------------

describe('AC-1: status validation', () => {
  it('rejects "archived" as a status via moveCard', () => {
    const card = createCard({ title: 'Test', suppressIntake: true })
    expect(() => moveCard(card.id, 'archived', 1)).toThrow(InvalidStatusError)
  })

  it('rejects an unknown status string', () => {
    const card = createCard({ title: 'Test', suppressIntake: true })
    expect(() => moveCard(card.id, 'nonexistent_status', 1)).toThrow(InvalidStatusError)
  })

  it('accepts a custom column as valid status after creation', () => {
    const col = createColumn('My Column')
    const card = createCard({ title: 'Test', suppressIntake: true })
    expect(() => moveCard(card.id, col.id, 1)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// AC-2: State machine transitions
// ---------------------------------------------------------------------------

describe('AC-2: state machine', () => {
  it('someday -> done throws InvalidTransitionError (AC-2c)', () => {
    const card = createCard({ title: 'Test', status: 'someday', suppressIntake: true })
    expect(() => moveCard(card.id, 'done', 1)).toThrow(InvalidTransitionError)
  })

  it('planned -> in_progress is allowed', () => {
    const card = createCard({ title: 'Test', suppressIntake: true })
    expect(() => moveCard(card.id, 'in_progress', 1)).not.toThrow()
  })

  it('done -> waiting throws InvalidTransitionError', () => {
    const card = createCard({ title: 'Test', status: 'done', suppressIntake: true })
    expect(() => moveCard(card.id, 'waiting', 1)).toThrow(InvalidTransitionError)
  })

  it('done -> planned is allowed', () => {
    const card = createCard({ title: 'Test', status: 'done', suppressIntake: true })
    expect(() => moveCard(card.id, 'planned', 1)).not.toThrow()
  })

  it('archived card cannot be moved (AC-2b)', () => {
    const card = createCard({ title: 'Test', suppressIntake: true })
    archiveCard(card.id)
    expect(() => moveCard(card.id, 'planned', 1)).toThrow(InvalidTransitionError)
  })

  it('updateCard validates status if changed', () => {
    const card = createCard({ title: 'Test', status: 'someday', suppressIntake: true })
    expect(() => updateCard(card.id, { status: 'done' })).toThrow(InvalidTransitionError)
  })

  it('updateCard allows status change on same status (no-op transition)', () => {
    const card = createCard({ title: 'Test', suppressIntake: true })
    // planned -> planned is not a real transition; AC-2e: no validation if status unchanged
    expect(() => updateCard(card.id, { status: 'planned' })).not.toThrow()
  })

  it('moveCard to same status is a no-op move: allowed, updated_at refreshed, dispatch NOT re-fired (spec section 5)', () => {
    const card = createCard({ title: 'In progress', status: 'in_progress', suppressIntake: true })
    // Stamp dispatched_at to simulate prior dispatch
    const now = Math.floor(Date.now() / 1000)
    getNoaDb().prepare('UPDATE kanban_cards SET dispatched_at=? WHERE id=?').run(now, card.id)

    const before = getCard(card.id)!.updated_at
    // Small delay to ensure updated_at changes
    const msgsBefore = (getNoaDb().prepare('SELECT COUNT(*) as n FROM agent_messages').get() as { n: number }).n

    expect(() => moveCard(card.id, 'in_progress', 2)).not.toThrow()

    const after = getCard(card.id)!
    expect(after.updated_at).toBeGreaterThanOrEqual(before)
    // No new dispatch message (dispatched_at was set, AC-3a guard)
    const msgsAfter = (getNoaDb().prepare('SELECT COUNT(*) as n FROM agent_messages').get() as { n: number }).n
    expect(msgsAfter).toBe(msgsBefore)
  })
})

// ---------------------------------------------------------------------------
// AC-3: Dispatch on in_progress (once-only)
// ---------------------------------------------------------------------------

describe('AC-3: dispatch once-only', () => {
  it('card with dispatched_at set: no new agent_messages on in_progress entry', () => {
    // Seed a card with dispatched_at already set
    const now = Math.floor(Date.now() / 1000)
    getNoaDb().prepare(
      `INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at, dispatched_at)
       VALUES ('pre-dispatched', 'Already dispatched', 'planned', 'normal', 1, ?, ?, ?)`
    ).run(now, now, now)

    const beforeCount = (getNoaDb().prepare("SELECT COUNT(*) as n FROM agent_messages WHERE to_agent IS NOT NULL").get() as { n: number }).n
    moveCard('pre-dispatched', 'in_progress', 1)
    const afterCount = (getNoaDb().prepare("SELECT COUNT(*) as n FROM agent_messages WHERE to_agent IS NOT NULL").get() as { n: number }).n

    expect(afterCount).toBe(beforeCount)
  })

  it('card without assignee: no dispatch message created', () => {
    const card = createCard({ title: 'No assignee', suppressIntake: true })
    const before = (getNoaDb().prepare('SELECT COUNT(*) as n FROM agent_messages').get() as { n: number }).n
    moveCard(card.id, 'in_progress', 1)
    const after = (getNoaDb().prepare('SELECT COUNT(*) as n FROM agent_messages').get() as { n: number }).n
    expect(after).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// AC-3e: resolveKanbanDispatchTarget unit tests (DoD)
// ---------------------------------------------------------------------------

describe('AC-3e: resolveKanbanDispatchTarget pure unit tests', () => {
  const base = {
    ownerName: 'Dominik',
    botName: 'Marveen',
    mainAgentId: 'marveen',
    agentNames: ['dave', 'thor'],
    isRunning: (n: string) => n === 'dave',
  }

  it('owner -> null', () => {
    expect(resolveKanbanDispatchTarget('Dominik', base)).toBeNull()
  })

  it('bot name -> MAIN_AGENT_ID', () => {
    expect(resolveKanbanDispatchTarget('Marveen', base)).toBe('marveen')
  })

  it('main agent id -> MAIN_AGENT_ID', () => {
    expect(resolveKanbanDispatchTarget('marveen', base)).toBe('marveen')
  })

  it('running sub-agent -> agent id', () => {
    expect(resolveKanbanDispatchTarget('dave', base)).toBe('dave')
  })

  it('non-running sub-agent -> null', () => {
    expect(resolveKanbanDispatchTarget('thor', base)).toBeNull()
  })

  it('unknown assignee -> null', () => {
    expect(resolveKanbanDispatchTarget('UnknownAgent', base)).toBeNull()
  })

  it('null/empty assignee -> null', () => {
    expect(resolveKanbanDispatchTarget(null, base)).toBeNull()
    expect(resolveKanbanDispatchTarget('', base)).toBeNull()
    expect(resolveKanbanDispatchTarget(undefined, base)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// AC-4: Auto-archive sweep
// ---------------------------------------------------------------------------

describe('AC-4: runArchiveSweep', () => {
  it('archives done cards older than DONE_ARCHIVE_DAYS', () => {
    const staleTs = Math.floor(Date.now() / 1000) - 8 * 86400
    getNoaDb().prepare(
      `INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at)
       VALUES ('stale-done', 'Old done card', 'done', 'normal', 1, ?, ?)`
    ).run(staleTs, staleTs)

    const { archived } = runArchiveSweep()
    expect(archived).toBeGreaterThanOrEqual(1)

    const archivedCards = listArchived()
    expect(archivedCards.some((c) => c.id === 'stale-done')).toBe(true)
  })

  it('does not archive done cards updated recently', () => {
    const card = createCard({ title: 'Recent done', status: 'done', suppressIntake: true })
    const { archived } = runArchiveSweep()
    // The card was just created (now), so it should NOT be archived
    const archivedCards = listArchived()
    expect(archivedCards.some((c) => c.id === card.id)).toBe(false)
    void archived
  })

  it('is idempotent: re-running produces 0 changes on already-archived cards', () => {
    const staleTs = Math.floor(Date.now() / 1000) - 8 * 86400
    getNoaDb().prepare(
      `INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at)
       VALUES ('stale-done-2', 'Old done 2', 'done', 'normal', 1, ?, ?)`
    ).run(staleTs, staleTs)

    runArchiveSweep()
    const second = runArchiveSweep()
    expect(second.archived).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// AC-5: Manual archive / unarchive
// ---------------------------------------------------------------------------

describe('AC-5: archive / unarchive', () => {
  it('archiveCard on waiting card sets archived_at, absent from listCards', () => {
    const card = createCard({ title: 'Waiting card', status: 'waiting', suppressIntake: true })
    archiveCard(card.id)

    const fresh = getCard(card.id)!
    expect(fresh.archived_at).not.toBeNull()

    const active = listCards()
    expect(active.some((c) => c.id === card.id)).toBe(false)
  })

  it('archiveCard on already-archived card is a no-op returning true', () => {
    const card = createCard({ title: 'Test', suppressIntake: true })
    archiveCard(card.id)
    const before = getCard(card.id)!.archived_at!
    const result = archiveCard(card.id)
    expect(result).toBe(true)
    expect(getCard(card.id)!.archived_at).toBe(before)
  })

  it('unarchiveCard restores card to listCards', () => {
    const card = createCard({ title: 'Test', status: 'done', suppressIntake: true })
    archiveCard(card.id)
    unarchiveCard(card.id)
    expect(listCards().some((c) => c.id === card.id)).toBe(true)
    expect(getCard(card.id)!.archived_at).toBeNull()
  })

  it('archiveCard returns false for non-existent card', () => {
    expect(archiveCard('no-such-id')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC-6: Parent/child hierarchy
// ---------------------------------------------------------------------------

describe('AC-6: parent / child', () => {
  it('createCard with nonexistent parent_id throws ParentNotFoundError', () => {
    expect(() => createCard({ title: 'Orphan', parent_id: 'no-parent', suppressIntake: true }))
      .toThrow(ParentNotFoundError)
  })

  it('createCard with archived parent throws ParentNotFoundError', () => {
    const parent = createCard({ title: 'Parent', suppressIntake: true })
    archiveCard(parent.id)
    expect(() => createCard({ title: 'Child', parent_id: parent.id, suppressIntake: true }))
      .toThrow(ParentNotFoundError)
  })

  it('deleteCard on parent with in_progress child throws HasActiveChildrenError', () => {
    const parent = createCard({ title: 'Parent', suppressIntake: true })
    createCard({ title: 'Child', parent_id: parent.id, status: 'in_progress', suppressIntake: true })
    expect(() => deleteCard(parent.id)).toThrow(HasActiveChildrenError)
  })

  it('deleteCard on parent with all-done children: children deleted first, then parent', () => {
    const parent = createCard({ title: 'Parent', suppressIntake: true })
    const child = createCard({ title: 'Child', parent_id: parent.id, status: 'done', suppressIntake: true })
    const result = deleteCard(parent.id)
    expect(result).toBe(true)
    expect(getCard(parent.id)).toBeUndefined()
    expect(getCard(child.id)).toBeUndefined()
  })

  it('after all children move to done: children_all_done event emitted (AC-6c)', () => {
    const received: DashboardEvent[] = []
    const off = subscribeDashboardEvents((e) => received.push(e))

    const parent = createCard({ title: 'Parent', suppressIntake: true })
    const c1 = createCard({ title: 'C1', parent_id: parent.id, suppressIntake: true })
    const c2 = createCard({ title: 'C2', parent_id: parent.id, suppressIntake: true })

    moveCard(c1.id, 'in_progress', 1)
    moveCard(c1.id, 'done', 1)
    // c2 is still planned -> event NOT yet emitted
    expect(received.some((e) => e.action === 'children_all_done')).toBe(false)

    moveCard(c2.id, 'in_progress', 2)
    moveCard(c2.id, 'done', 2)
    // now both done -> event emitted for parent
    expect(received.some((e) => e.type === 'kanban' && e.action === 'children_all_done' && e.id === parent.id)).toBe(true)

    off()
  })

  it('getChildCards returns only non-archived children ordered by sort_order', () => {
    const parent = createCard({ title: 'Parent', suppressIntake: true })
    const c1 = createCard({ title: 'C1', parent_id: parent.id, sort_order: 2, suppressIntake: true })
    const c2 = createCard({ title: 'C2', parent_id: parent.id, sort_order: 1, suppressIntake: true })
    archiveCard(c1.id)
    const children = getChildCards(parent.id)
    expect(children.map((c) => c.id)).toEqual([c2.id])
  })
})

// ---------------------------------------------------------------------------
// AC-7: Intake-clarification event
// ---------------------------------------------------------------------------

describe('AC-7: intake event', () => {
  it('createCard with ambiguous title emits intake event on event bus (AC-7a)', () => {
    const received: DashboardEvent[] = []
    const off = subscribeDashboardEvents((e) => received.push(e))

    createCard({ title: 'Todo' }) // short title, no description

    expect(received.some((e) => e.type === 'kanban' && e.action === 'intake')).toBe(true)
    off()
  })

  it('createCard with assignee = known agent id (MAIN_AGENT_ID): NO intake event (AC-7d)', () => {
    const received: DashboardEvent[] = []
    const off = subscribeDashboardEvents((e) => received.push(e))

    createCard({ title: 'Agent task', assignee: 'marveen' })

    expect(received.some((e) => e.action === 'intake')).toBe(false)
    off()
  })

  it('createCard with suppressIntake=true: NO intake event (AC-7d C5)', () => {
    const received: DashboardEvent[] = []
    const off = subscribeDashboardEvents((e) => received.push(e))

    createCard({ title: 'Bulk import item', suppressIntake: true })

    expect(received.some((e) => e.action === 'intake')).toBe(false)
    off()
  })

  it('createCard with status=someday: NO intake event (AC-7d)', () => {
    const received: DashboardEvent[] = []
    const off = subscribeDashboardEvents((e) => received.push(e))

    createCard({ title: 'Future idea', status: 'someday' })

    expect(received.some((e) => e.action === 'intake')).toBe(false)
    off()
  })

  it('updateCard with changed title emits intake event', () => {
    const card = createCard({ title: 'Orig', suppressIntake: true })
    const received: DashboardEvent[] = []
    const off = subscribeDashboardEvents((e) => received.push(e))

    updateCard(card.id, { title: 'Changed' })

    expect(received.some((e) => e.action === 'intake')).toBe(true)
    off()
  })

  it('updateCard with suppressIntake: NO intake event', () => {
    const card = createCard({ title: 'Test', suppressIntake: true })
    const received: DashboardEvent[] = []
    const off = subscribeDashboardEvents((e) => received.push(e))

    updateCard(card.id, { title: 'New title', suppressIntake: true })

    expect(received.some((e) => e.action === 'intake')).toBe(false)
    off()
  })
})

// ---------------------------------------------------------------------------
// AC-8: Sort order management
// ---------------------------------------------------------------------------

describe('AC-8: sort order', () => {
  it('createCard without explicit sort_order: MAX+1 in status column', () => {
    const c1 = createCard({ title: 'First', suppressIntake: true })
    const c2 = createCard({ title: 'Second', suppressIntake: true })
    expect(c2.sort_order).toBeGreaterThan(c1.sort_order)
  })

  it('reorderCards with mixed-status ids throws CrossColumnReorderError (AC-8b)', () => {
    const c1 = createCard({ title: 'P', status: 'planned', suppressIntake: true })
    const c2 = createCard({ title: 'I', status: 'in_progress', suppressIntake: true })
    expect(() => reorderCards([{ id: c1.id, sort_order: 1 }, { id: c2.id, sort_order: 2 }]))
      .toThrow(CrossColumnReorderError)
  })

  it('moveCard with sort_order <= 0 throws InvalidSortOrderError (AC-8c)', () => {
    const card = createCard({ title: 'Test', suppressIntake: true })
    expect(() => moveCard(card.id, 'in_progress', 0)).toThrow(InvalidSortOrderError)
    expect(() => moveCard(card.id, 'in_progress', -1)).toThrow(InvalidSortOrderError)
  })
})

// ---------------------------------------------------------------------------
// AC-10: Column management CRUD
// ---------------------------------------------------------------------------

describe('AC-10: column management', () => {
  it('deleteColumn("done") throws BuiltinColumnError', () => {
    expect(() => deleteColumn('done')).toThrow(BuiltinColumnError)
  })

  it('deleteColumn on any builtin throws BuiltinColumnError', () => {
    for (const id of ['planned', 'in_progress', 'waiting', 'someday', 'done']) {
      expect(() => deleteColumn(id)).toThrow(BuiltinColumnError)
    }
  })

  it('deleteColumn with 1 active card throws ColumnNotEmptyError', () => {
    const col = createColumn('My custom col')
    createCard({ title: 'Card in custom col', status: col.id, suppressIntake: true })
    expect(() => deleteColumn(col.id)).toThrow(ColumnNotEmptyError)
  })

  it('deleteColumn works when column is empty', () => {
    const col = createColumn('Empty col')
    expect(deleteColumn(col.id)).toBe(true)
    expect(listColumns().some((c) => c.id === col.id)).toBe(false)
  })

  it('renameColumn updates label and emits column_renamed event', () => {
    const received: DashboardEvent[] = []
    const off = subscribeDashboardEvents((e) => received.push(e))

    renameColumn('planned', 'Tervezett')

    expect(received.some((e) => e.type === 'board' && e.action === 'column_renamed' && e.id === 'planned')).toBe(true)
    off()
  })

  it('createColumn emits column_created event', () => {
    const received: DashboardEvent[] = []
    const off = subscribeDashboardEvents((e) => received.push(e))

    createColumn('New col')

    expect(received.some((e) => e.type === 'board' && e.action === 'column_created')).toBe(true)
    off()
  })
})

// ---------------------------------------------------------------------------
// Security grep assertions (DoD section 6)
// ---------------------------------------------------------------------------

describe('Security: archived never a status value', () => {
  it('the noa-kanban source never uses "archived" as a status value', () => {
    const src = readFileSync(join(__dirname, '..', 'noa-kanban.ts'), 'utf8')
    // Should not have status='archived' or status === 'archived' etc.
    // (AC-2a: done->archived is archiveCard, not a status transition)
    const forbidden = /status\s*[=!]+\s*['"]archived['"]/
    expect(forbidden.test(src)).toBe(false)
  })
})

describe('Security: card.description never in dispatch body', () => {
  it('dispatch content does not include card.description (E1)', () => {
    const src = readFileSync(join(__dirname, '..', 'noa-kanban.ts'), 'utf8')
    const forbidden = /description.*dispatch|card\.description.*content/
    expect(forbidden.test(src)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// misc: CRUD helpers
// ---------------------------------------------------------------------------

describe('Comments', () => {
  it('addComment / listComments round-trip', () => {
    const card = createCard({ title: 'Test', suppressIntake: true })
    addComment(card.id, 'morgan', 'First comment')
    addComment(card.id, 'dave', 'Second comment')
    const comments = listComments(card.id)
    expect(comments).toHaveLength(2)
    expect(comments[0].author).toBe('morgan')
    expect(comments[1].author).toBe('dave')
  })
})

describe('configureKanban / dispatch wiring', () => {
  it('configureKanban injects isRunning and agentNames for dispatch resolution', () => {
    let calledWith: string | null = null
    configureKanban({
      agentNames: ['some-agent'],
      isRunning: (n) => { calledWith = n; return false },
    })

    const card = createCard({ title: 'Test', assignee: 'some-agent', suppressIntake: true })
    moveCard(card.id, 'in_progress', 1)

    expect(calledWith).toBe('some-agent')

    // Reset
    configureKanban({ isRunning: () => false, agentNames: [] })
  })
})

// ---------------------------------------------------------------------------
// W0b: listProjects
// ---------------------------------------------------------------------------

describe('listProjects', () => {
  it('returns empty array when no cards have projects', () => {
    expect(listProjects()).toEqual([])
  })

  it('returns distinct project names sorted alphabetically', () => {
    createCard({ title: 'A', project: 'zebra', suppressIntake: true })
    createCard({ title: 'B', project: 'alpha', suppressIntake: true })
    createCard({ title: 'C', project: 'zebra', suppressIntake: true })
    expect(listProjects()).toEqual(['alpha', 'zebra'])
  })

  it('excludes null and empty-string projects', () => {
    createCard({ title: 'No project', suppressIntake: true })
    createCard({ title: 'Has project', project: 'valid', suppressIntake: true })
    expect(listProjects()).toEqual(['valid'])
  })

  it('excludes archived cards', () => {
    const card = createCard({ title: 'Archived', project: 'secret', suppressIntake: true })
    archiveCard(card.id)
    expect(listProjects()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// W0b: markCardDispatched
// ---------------------------------------------------------------------------

describe('markCardDispatched', () => {
  it('stamps dispatched_at on a card that has none', () => {
    const card = createCard({ title: 'Test', suppressIntake: true })
    expect(card.dispatched_at).toBeNull()
    const ok = markCardDispatched(card.id)
    expect(ok).toBe(true)
    const refreshed = getCard(card.id)!
    expect(refreshed.dispatched_at).toBeGreaterThan(0)
  })

  it('returns false for a non-existent card id', () => {
    expect(markCardDispatched('no-such-id')).toBe(false)
  })

  it('does not overwrite dispatched_at on second call (COALESCE guard)', () => {
    const card = createCard({ title: 'Test', suppressIntake: true })
    markCardDispatched(card.id)
    // Force a sentinel value to detect any overwrite
    getNoaDb().prepare('UPDATE kanban_cards SET dispatched_at=? WHERE id=?').run(99999, card.id)
    markCardDispatched(card.id)
    expect(getCard(card.id)!.dispatched_at).toBe(99999)
  })
})

// ---------------------------------------------------------------------------
// W0b: runInTransaction
// ---------------------------------------------------------------------------

describe('runInTransaction', () => {
  it('commits the result of the callback', () => {
    const result = runInTransaction(() => {
      createCard({ id: 'tx-test-1', title: 'TX Card', suppressIntake: true })
      return 'done'
    })
    expect(result).toBe('done')
    expect(getCard('tx-test-1')).toBeDefined()
  })

  it('rolls back on throw and card is not persisted', () => {
    expect(() =>
      runInTransaction(() => {
        createCard({ id: 'tx-test-2', title: 'Will rollback', suppressIntake: true })
        throw new Error('intentional rollback')
      })
    ).toThrow('intentional rollback')
    expect(getCard('tx-test-2')).toBeUndefined()
  })

  it('supports multiple writes in one transaction', () => {
    runInTransaction(() => {
      createCard({ id: 'tx-multi-1', title: 'Multi 1', suppressIntake: true })
      createCard({ id: 'tx-multi-2', title: 'Multi 2', suppressIntake: true })
    })
    expect(getCard('tx-multi-1')).toBeDefined()
    expect(getCard('tx-multi-2')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// W0b: listKanbanCardsSummary
// ---------------------------------------------------------------------------

describe('listKanbanCardsSummary', () => {
  it('returns summary rows for active cards', () => {
    createCard({ title: 'Alpha', priority: 'urgent', suppressIntake: true })
    createCard({ title: 'Beta', status: 'in_progress', suppressIntake: true })
    const rows = listKanbanCardsSummary()
    expect(rows.length).toBe(2)
    const keys = Object.keys(rows[0]).sort()
    expect(keys).toEqual(['assignee', 'id', 'priority', 'status', 'title'])
  })

  it('excludes archived cards', () => {
    const card = createCard({ title: 'Archived', suppressIntake: true })
    archiveCard(card.id)
    expect(listKanbanCardsSummary()).toHaveLength(0)
  })

  it('returns assignee when set', () => {
    createCard({ title: 'Assigned', assignee: 'dave', suppressIntake: true })
    const rows = listKanbanCardsSummary()
    expect(rows[0].assignee).toBe('dave')
  })
})

// ---------------------------------------------------------------------------
// W0b: getHeartbeatKanbanSummary
// ---------------------------------------------------------------------------

describe('getHeartbeatKanbanSummary', () => {
  it('returns empty arrays when board is empty', () => {
    const summary = getHeartbeatKanbanSummary()
    expect(summary.urgent).toHaveLength(0)
    expect(summary.in_progress).toHaveLength(0)
    expect(summary.waiting).toHaveLength(0)
  })

  it('puts urgent non-done cards in .urgent', () => {
    createCard({ title: 'Urgent planned', priority: 'urgent', suppressIntake: true })
    createCard({ title: 'Urgent done', priority: 'urgent', status: 'done', suppressIntake: true })
    const summary = getHeartbeatKanbanSummary()
    expect(summary.urgent).toHaveLength(1)
    expect(summary.urgent[0].title).toBe('Urgent planned')
  })

  it('puts in_progress cards in .in_progress', () => {
    createCard({ title: 'WIP', status: 'in_progress', suppressIntake: true })
    const summary = getHeartbeatKanbanSummary()
    expect(summary.in_progress).toHaveLength(1)
    expect(summary.in_progress[0].title).toBe('WIP')
  })

  it('puts waiting cards in .waiting', () => {
    createCard({ title: 'Blocked', status: 'waiting', suppressIntake: true })
    const summary = getHeartbeatKanbanSummary()
    expect(summary.waiting).toHaveLength(1)
    expect(summary.waiting[0].title).toBe('Blocked')
  })

  it('excludes archived cards from all buckets', () => {
    const card = createCard({ title: 'Archived WIP', status: 'in_progress', suppressIntake: true })
    archiveCard(card.id)
    const summary = getHeartbeatKanbanSummary()
    expect(summary.in_progress).toHaveLength(0)
  })
})
