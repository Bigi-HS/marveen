import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  initDatabase,
  createAgentMessage,
  markMessageDelivered,
  markMessageDone,
  markMessageFailed,
} from '../db.js'
import { initNoaDb, getNoaDb } from '../noa-memory.js'
import {
  createCard,
  updateCard,
  moveCard,
  archiveCard,
  deleteCard,
  addComment,
  runInTransaction,
  invalidateColumnsCache,
  configureKanban,
} from '../noa-kanban.js'
import { subscribeDashboardEvents, type DashboardEvent } from '../event-bus.js'

// Card 7c7ea226 fork E: emits live at the db chokepoints (db.ts for messages,
// noa-kanban.ts for kanban), so EVERY write path broadcasts -- not just the
// route layer. These tests subscribe to the real singleton bus and assert each
// write fn emits the right typed event, and that a throwing subscriber never
// breaks the underlying write.

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(__dirname, '..', '..', 'scripts', 'schema-noa.sql'), 'utf8')

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  // db.ts in-memory for agent_messages
  initDatabase(':memory:')
  // noa-kanban in-memory for kanban ops
  initNoaDb(':memory:')
  getNoaDb().exec(SCHEMA_SQL)
  // suppress kanban dispatch (no agents running in test) to avoid extra message/created events
  configureKanban({ isRunning: () => false })
})

let seen: DashboardEvent[]
let off: () => void
beforeEach(() => {
  seen = []
  off = subscribeDashboardEvents((e) => seen.push(e))
  // keep noa-kanban column cache fresh
  invalidateColumnsCache()
})
afterEach(() => off())

let n = 0
const freshId = (): string => `c-${++n}`

describe('kanban emits (card 7c7ea226)', () => {
  it('createCard emits kanban/created with the card id', () => {
    const id = freshId()
    createCard({ id, title: 'T', suppressIntake: true })
    expect(seen).toEqual([{ type: 'kanban', id, action: 'created' }])
  })

  it('updateCard emits kanban/updated on success', () => {
    const id = freshId()
    createCard({ id, title: 'T', suppressIntake: true })
    seen = []
    updateCard(id, { title: 'T2', suppressIntake: true })
    expect(seen).toEqual([{ type: 'kanban', id, action: 'updated' }])
  })

  it('updateCard on a missing card emits nothing', () => {
    updateCard('nope', { title: 'x' })
    expect(seen).toEqual([])
  })

  it('moveCard emits kanban/moved on success', () => {
    const id = freshId()
    createCard({ id, title: 'T', suppressIntake: true })
    seen = []
    moveCard(id, 'in_progress', 1.0)
    expect(seen).toEqual([{ type: 'kanban', id, action: 'moved' }])
  })

  it('archiveCard emits kanban/archived on success', () => {
    const id = freshId()
    createCard({ id, title: 'T', suppressIntake: true })
    seen = []
    archiveCard(id)
    expect(seen).toEqual([{ type: 'kanban', id, action: 'archived' }])
  })

  it('addComment emits kanban/comment with the card id', () => {
    const id = freshId()
    createCard({ id, title: 'T', suppressIntake: true })
    seen = []
    addComment(id, 'dave', 'hi')
    expect(seen).toEqual([{ type: 'kanban', id, action: 'comment' }])
  })

  it('deleteCard emits kanban/deleted on success', () => {
    const id = freshId()
    createCard({ id, title: 'T', suppressIntake: true })
    seen = []
    deleteCard(id)
    expect(seen).toEqual([{ type: 'kanban', id, action: 'deleted' }])
  })
})

describe('agent_messages emits (card 7c7ea226)', () => {
  it('createAgentMessage emits message/created with the new id', () => {
    const msg = createAgentMessage('thor', 'dave', 'ping')
    expect(seen).toEqual([{ type: 'message', id: String(msg.id), action: 'created' }])
  })

  it('markMessageDelivered/Done/Failed each emit the right action', () => {
    const msg = createAgentMessage('thor', 'dave', 'ping')
    seen = []
    markMessageDelivered(msg.id)
    markMessageDone(msg.id, 'ok')
    markMessageFailed(msg.id, 'err')
    expect(seen).toEqual([
      { type: 'message', id: String(msg.id), action: 'delivered' },
      { type: 'message', id: String(msg.id), action: 'done' },
      { type: 'message', id: String(msg.id), action: 'failed' },
    ])
  })
})

describe('transaction-aware emit (card 7c7ea226, NoA focus #2)', () => {
  it('buffers events inside runInTransaction and flushes them on commit', () => {
    const a = freshId()
    const b = freshId()
    runInTransaction(() => {
      createCard({ id: a, title: 'A', suppressIntake: true })
      createCard({ id: b, title: 'B', suppressIntake: true })
      // events are buffered, not yet emitted, while the txn is open
      expect(seen).toEqual([])
    })
    expect(seen).toEqual([
      { type: 'kanban', id: a, action: 'created' },
      { type: 'kanban', id: b, action: 'created' },
    ])
  })

  it('discards buffered events when the transaction rolls back', () => {
    const a = freshId()
    expect(() => runInTransaction(() => {
      createCard({ id: a, title: 'A', suppressIntake: true })
      throw new Error('rollback')
    })).toThrow('rollback')
    // no event for the rolled-back write...
    expect(seen).toEqual([])
    // ...and the row really was rolled back
    expect(updateCard(a, { title: 'x' })).toBe(false)
  })
})

describe('emit never breaks the write (card 7c7ea226)', () => {
  it('a throwing subscriber does not prevent the kanban write', () => {
    const offBad = subscribeDashboardEvents(() => { throw new Error('boom') })
    const id = freshId()
    expect(() => createCard({ id, title: 'T', suppressIntake: true })).not.toThrow()
    offBad()
    // the write landed despite the faulty subscriber
    expect(updateCard(id, { title: 'T2', suppressIntake: true })).toBe(true)
  })
})
