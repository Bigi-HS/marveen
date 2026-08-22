// Tests for card 0ae61457 (A2): escalation-state persistence across restarts.
//
// Verifies that:
//   1. updateMessageLastEscalatedAt persists the timestamp to the DB row.
//   2. loadEscalationState reads only PENDING rows with a non-null last_escalated_at.
//   3. The round-trip (write -> reload) correctly seeds the in-process Map so a
//      restart does not re-fire in-band escalation alerts for already-escalated msgs.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { initDatabase, createAgentMessage, markMessageDelivered } from '../db.js'
import {
  updateMessageLastEscalatedAt,
  loadEscalationState,
} from '../db.js'

const TEST_DB = '/tmp/test-escalation-persist.db'

function cleanDb() {
  for (const s of ['', '-wal', '-shm']) rmSync(TEST_DB + s, { force: true })
}

function makeMsg(from = 'dave', to = 'marveen') {
  return createAgentMessage(from, to, 'test msg', false, 'normal', null)
}

beforeEach(() => {
  cleanDb()
  initDatabase(TEST_DB)
})
afterEach(() => cleanDb())

describe('updateMessageLastEscalatedAt', () => {
  it('writes the timestamp to the DB row', () => {
    const msg = makeMsg()
    updateMessageLastEscalatedAt(msg.id, 1_700_000_000_000)
    const state = loadEscalationState()
    expect(state.get(msg.id)).toBe(1_700_000_000_000)
  })

  it('no-ops on unknown id without throwing', () => {
    expect(() => updateMessageLastEscalatedAt(99999, 1_700_000_000_000)).not.toThrow()
  })
})

describe('loadEscalationState', () => {
  it('returns empty map when no pending messages have been escalated', () => {
    makeMsg()
    expect(loadEscalationState().size).toBe(0)
  })

  it('returns only escalated pending messages', () => {
    const a = makeMsg()
    const b = makeMsg()
    updateMessageLastEscalatedAt(a.id, 1_700_000_001_000)
    // b not escalated
    const state = loadEscalationState()
    expect(state.size).toBe(1)
    expect(state.get(a.id)).toBe(1_700_000_001_000)
    expect(state.has(b.id)).toBe(false)
  })

  it('excludes delivered messages even if they have a last_escalated_at', () => {
    const msg = makeMsg()
    updateMessageLastEscalatedAt(msg.id, 1_700_000_000_000)
    markMessageDelivered(msg.id)
    // Delivered -> status is 'delivered', not 'pending': must be excluded.
    expect(loadEscalationState().size).toBe(0)
  })

  it('round-trips correctly: write then reload gives back exact timestamp', () => {
    const msg = makeMsg()
    const ts = 1_750_123_456_789
    updateMessageLastEscalatedAt(msg.id, ts)
    const loaded = loadEscalationState()
    expect(loaded.get(msg.id)).toBe(ts)
  })

  it('handles multiple escalated pending messages', () => {
    const msgs = [makeMsg(), makeMsg(), makeMsg()]
    const timestamps = [1_700_000_001_000, 1_700_000_002_000, 1_700_000_003_000]
    msgs.forEach((m, i) => updateMessageLastEscalatedAt(m.id, timestamps[i]))
    const state = loadEscalationState()
    expect(state.size).toBe(3)
    msgs.forEach((m, i) => expect(state.get(m.id)).toBe(timestamps[i]))
  })
})
