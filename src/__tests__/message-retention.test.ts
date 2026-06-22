// Tests for card f1ea52c0 (layer 3): agent_messages retention sweep.
//
// The table grew without bound -- delivered/done rows are never pruned and
// stale pending/failed rows linger (89 eight-day-old rows had to be deleted by
// hand on 2026-06-22). deleteOldMessages removes any row past the retention
// cutoff; startMessageRetentionSweep runs it on a low-frequency interval.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { initDatabase, getDb, deleteOldMessages, MESSAGE_RETENTION_SEC } from '../db.js'
import { startMessageRetentionSweep } from '../web/message-retention.js'

const TEST_DB = '/tmp/test-message-retention.db'
const NOW = 1_700_000_000 // fixed epoch SECONDS

function cleanDb() {
  for (const s of ['', '-wal', '-shm']) rmSync(TEST_DB + s, { force: true })
}

// Insert a row with an explicit created_at + status, bypassing saveAgentMessage
// (which always stamps now/pending), so age/status combinations are controllable.
function insert(status: string, createdAt: number): number {
  const info = getDb().prepare(
    "INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at, ack_expected, priority) VALUES ('a','b','x',?,?,0,'normal')",
  ).run(status, createdAt)
  return Number(info.lastInsertRowid)
}

function count(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM agent_messages').get() as { n: number }).n
}

beforeEach(() => {
  cleanDb()
  initDatabase(TEST_DB)
})
afterAll(() => cleanDb())

describe('deleteOldMessages (db layer, card f1ea52c0)', () => {
  const RETENTION = 7 * 24 * 60 * 60

  it('removes rows older than the retention cutoff', () => {
    insert('delivered', NOW - RETENTION - 1) // just past cutoff
    expect(deleteOldMessages(NOW, RETENTION)).toBe(1)
    expect(count()).toBe(0)
  })

  it('keeps rows newer than the cutoff', () => {
    insert('delivered', NOW - RETENTION + 60) // inside the window
    expect(deleteOldMessages(NOW, RETENTION)).toBe(0)
    expect(count()).toBe(1)
  })

  it('treats the exact cutoff as still-retained (strict less-than)', () => {
    insert('done', NOW - RETENTION) // created_at == cutoff
    expect(deleteOldMessages(NOW, RETENTION)).toBe(0)
    expect(count()).toBe(1)
  })

  // The card: stale delivered/done/failed AND pending rows must all be cleaned.
  // A pending row this old is unambiguously abandoned (the delivery hard-TTL
  // gives up within hours, far inside 7 days).
  it('prunes every status once past the cutoff', () => {
    for (const s of ['pending', 'delivered', 'done', 'failed']) insert(s, NOW - RETENTION - 100)
    expect(deleteOldMessages(NOW, RETENTION)).toBe(4)
    expect(count()).toBe(0)
  })

  it('prunes only the aged rows in a mixed table', () => {
    insert('delivered', NOW - RETENTION - 100) // old
    insert('failed', NOW - RETENTION - 100)    // old
    const fresh = insert('pending', NOW - 60)  // recent, must survive
    expect(deleteOldMessages(NOW, RETENTION)).toBe(2)
    const rows = getDb().prepare('SELECT id FROM agent_messages').all() as { id: number }[]
    expect(rows.map(r => r.id)).toEqual([fresh])
  })

  it('is a no-op on an empty table', () => {
    expect(deleteOldMessages(NOW, RETENTION)).toBe(0)
  })

  it('defaults to MESSAGE_RETENTION_SEC (7 days)', () => {
    expect(MESSAGE_RETENTION_SEC).toBe(RETENTION)
    insert('delivered', NOW - MESSAGE_RETENTION_SEC - 1)
    insert('delivered', NOW - 100)
    expect(deleteOldMessages(NOW)).toBe(1)
    expect(count()).toBe(1)
  })
})

describe('startMessageRetentionSweep', () => {
  afterAll(() => vi.useRealTimers())

  it('prunes aged rows on each interval tick', () => {
    vi.useFakeTimers()
    insert('delivered', Math.floor(Date.now() / 1000) - MESSAGE_RETENTION_SEC - 1)
    const timer = startMessageRetentionSweep({ intervalMs: 1000 })
    expect(count()).toBe(1) // not yet swept
    vi.advanceTimersByTime(1000)
    expect(count()).toBe(0) // swept on the tick
    clearInterval(timer)
    vi.useRealTimers()
  })
})
