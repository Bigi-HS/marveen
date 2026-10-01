// a4d7b541: token_usage retention prune
// Tests: happy path, boundary, count, default constant, empty table.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { rmSync } from 'node:fs'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
import { initDatabase, getDb, pruneTokenUsage, TOKEN_USAGE_RETENTION_SEC } from '../db.js'

const TEST_DB = '/tmp/test-token-usage-prune.db'

function insertRow(timestamp: number, agent = 'test-agent'): void {
  getDb().prepare(
    'INSERT OR IGNORE INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)'
  ).run(agent, `sess-${timestamp}`, timestamp, 1, 1)
}

function countRows(): number {
  return (getDb().prepare('SELECT COUNT(*) as c FROM token_usage').get() as { c: number }).c
}

beforeEach(() => { rmSync(TEST_DB, { force: true }); initDatabase(TEST_DB) })
afterAll(() => rmSync(TEST_DB, { force: true }))

describe('pruneTokenUsage', () => {
  it('deletes rows older than retention and returns count', () => {
    const now = Math.floor(Date.now() / 1000)
    const ancient = now - TOKEN_USAGE_RETENTION_SEC - 3600 // just past the window
    const recent = now - 3600 // 1 hour ago

    insertRow(ancient)
    insertRow(recent)

    const deleted = pruneTokenUsage(now)
    expect(deleted).toBe(1)
    expect(countRows()).toBe(1)
  })

  it('keeps rows exactly at the cutoff boundary (strict less-than)', () => {
    const now = Math.floor(Date.now() / 1000)
    const atCutoff = now - TOKEN_USAGE_RETENTION_SEC

    insertRow(atCutoff)

    const deleted = pruneTokenUsage(now)
    expect(deleted).toBe(0)
    expect(countRows()).toBe(1)
  })

  it('returns 0 on an empty table', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(pruneTokenUsage(now)).toBe(0)
  })

  it('respects a custom retention window', () => {
    const now = Math.floor(Date.now() / 1000)
    const retention = 7 * 24 * 3600 // 7 days
    const oldEnough = now - retention - 1
    const tooNew = now - retention + 1

    insertRow(oldEnough)
    insertRow(tooNew)

    const deleted = pruneTokenUsage(now, retention)
    expect(deleted).toBe(1)
  })

  it('TOKEN_USAGE_RETENTION_SEC is 90 days', () => {
    expect(TOKEN_USAGE_RETENTION_SEC).toBe(90 * 24 * 60 * 60)
  })
})
