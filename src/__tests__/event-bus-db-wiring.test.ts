import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import {
  initDatabase,
  createKanbanCard,
  updateKanbanCard,
  moveKanbanCard,
  archiveKanbanCard,
  deleteKanbanCard,
  addKanbanComment,
  createAgentMessage,
  markMessageDelivered,
  markMessageDone,
  markMessageFailed,
} from '../db.js'
import { subscribeDashboardEvents, type DashboardEvent } from '../event-bus.js'

// Card 7c7ea226 fork E: emits live at the db.ts chokepoint, so EVERY write path
// (REST API, kanban dispatch, scripts) broadcasts -- not just the route layer.
// These tests subscribe to the real singleton bus and assert each write fn
// emits the right typed event, and that a throwing subscriber never breaks the
// underlying write.

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

let seen: DashboardEvent[]
let off: () => void
beforeEach(() => {
  seen = []
  off = subscribeDashboardEvents((e) => seen.push(e))
})
afterEach(() => off())

let n = 0
const freshId = (): string => `c-${++n}`

describe('kanban emits (card 7c7ea226)', () => {
  it('createKanbanCard emits kanban/created with the card id', () => {
    const id = freshId()
    createKanbanCard({ id, title: 'T' })
    expect(seen).toEqual([{ type: 'kanban', id, action: 'created' }])
  })

  it('updateKanbanCard emits kanban/updated on success', () => {
    const id = freshId()
    createKanbanCard({ id, title: 'T' })
    seen = []
    updateKanbanCard(id, { title: 'T2' })
    expect(seen).toEqual([{ type: 'kanban', id, action: 'updated' }])
  })

  it('updateKanbanCard on a missing card emits nothing', () => {
    updateKanbanCard('nope', { title: 'x' })
    expect(seen).toEqual([])
  })

  it('moveKanbanCard emits kanban/moved on success', () => {
    const id = freshId()
    createKanbanCard({ id, title: 'T' })
    seen = []
    moveKanbanCard(id, 'in_progress', 0)
    expect(seen).toEqual([{ type: 'kanban', id, action: 'moved' }])
  })

  it('archiveKanbanCard emits kanban/archived on success', () => {
    const id = freshId()
    createKanbanCard({ id, title: 'T' })
    seen = []
    archiveKanbanCard(id)
    expect(seen).toEqual([{ type: 'kanban', id, action: 'archived' }])
  })

  it('addKanbanComment emits kanban/comment with the card id', () => {
    const id = freshId()
    createKanbanCard({ id, title: 'T' })
    seen = []
    addKanbanComment(id, 'dave', 'hi')
    expect(seen).toEqual([{ type: 'kanban', id, action: 'comment' }])
  })

  it('deleteKanbanCard emits kanban/deleted on success', () => {
    const id = freshId()
    createKanbanCard({ id, title: 'T' })
    seen = []
    deleteKanbanCard(id)
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

describe('emit never breaks the write (card 7c7ea226)', () => {
  it('a throwing subscriber does not prevent the kanban write', () => {
    const offBad = subscribeDashboardEvents(() => { throw new Error('boom') })
    const id = freshId()
    expect(() => createKanbanCard({ id, title: 'T' })).not.toThrow()
    offBad()
    // the write landed despite the faulty subscriber
    expect(updateKanbanCard(id, { title: 'T2' })).toBe(true)
  })
})
