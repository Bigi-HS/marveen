import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, getDb, createAgentMessage, getPendingMessages } from '../db.js'
import { thresholdsForPriority, orderPendingByPriority } from '../web/delivery-retry.js'

// Card 88849f24 (A1->B1 cutover gate): after the noa.db cutover,
// agent_messages.priority is an INTEGER column (25/50/75/100). createAgentMessage
// must persist an INTEGER (the TEXT CHECK is gone; a number is the clean form),
// and the delivery read path must keep working on those integers. We simulate
// the post-cutover schema by rebuilding agent_messages as INTEGER BEFORE any
// write, so the lazy column probe sees the integer column.
beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:') // resets the cached priority-column probe
  const db = getDb()
  db.exec('DROP TABLE IF EXISTS agent_messages')
  db.exec(`CREATE TABLE agent_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 50,
    in_reply_to INTEGER,
    ack_expected INTEGER NOT NULL DEFAULT 0,
    result TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    completed_at INTEGER,
    last_escalated_at INTEGER
  )`)
})

function rawStored(id: number): { priority: unknown; t: string } {
  return getDb()
    .prepare('SELECT priority, typeof(priority) AS t FROM agent_messages WHERE id = ?')
    .get(id) as { priority: unknown; t: string }
}

describe('createAgentMessage against an INTEGER priority column (post-cutover noa.db)', () => {
  it('stores a string priority as its canonical INTEGER', () => {
    const msg = createAgentMessage('thor', 'dave', 'gate-req urgent', false, 'urgent')
    expect(msg.priority).toBe(100)
    const row = rawStored(msg.id)
    expect(row.t).toBe('integer')
    expect(row.priority).toBe(100)
  })

  it('defaults an unspecified priority to the integer normal (50)', () => {
    const msg = createAgentMessage('thor', 'dave', 'no explicit priority')
    expect(msg.priority).toBe(50)
    expect(rawStored(msg.id).t).toBe('integer')
  })

  it('passes a numeric priority through unchanged', () => {
    const msg = createAgentMessage('thor', 'dave', 'already an int', false, 75)
    expect(msg.priority).toBe(75)
    expect(rawStored(msg.id).priority).toBe(75)
  })

  it('read path: pending integers drive correct ordering + escalation timing', () => {
    createAgentMessage('thor', 'dave', 'low one', false, 'low')
    const urgent = createAgentMessage('thor', 'dave', 'urgent one', false, 'urgent')
    const pending = getPendingMessages('dave')
    // every stored priority is a number now
    expect(pending.every((m) => typeof m.priority === 'number')).toBe(true)
    // urgent (100) sorts ahead of low (25)
    const ordered = orderPendingByPriority(pending)
    expect(ordered[0].priority).toBe(100)
    // integer urgent still escalates at 15 min
    expect(thresholdsForPriority(urgent.priority).escalateAfterMs).toBe(15 * 60 * 1000)
  })
})
