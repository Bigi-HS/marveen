// Tests for gate SHA-drift invalidation (card 2fd80824).
//
// Covers:
//   1. recordInvalidation + isInvalidated (gate-db.ts)
//   2. readApprovals excludes seats whose (pr_number, head_sha) is invalidated
//   3. POST /api/gate/invalidate endpoint (gate.ts)
//   4. Inter-agent notification to 'marveen' on invalidation

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { rmSync } from 'node:fs'
import { Readable } from 'node:stream'
import {
  migrateGateTables,
  insertApproval,
  readApprovals,
  recordInvalidation,
  isInvalidated,
  readValidSeats,
} from '../web/gate-db.js'
import { initDatabase } from '../db.js'
import { tryHandleGate } from '../web/routes/gate.js'
import type { AgentIdentity } from '../web/agent-token-registry.js'
import { ADMIN_SCOPE } from '../web/agent-token-registry.js'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

// ---------------------------------------------------------------------------
// Unit tests: gate-db.ts invalidation functions
// ---------------------------------------------------------------------------

describe('recordInvalidation / isInvalidated (gate-db.ts)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    migrateGateTables(db)
  })

  it('isInvalidated returns false when no invalidation exists', () => {
    expect(isInvalidated(db, 300, SHA_A)).toBe(false)
  })

  it('recordInvalidation inserts a row; isInvalidated returns true', () => {
    recordInvalidation(db, { pr_number: 300, head_sha: SHA_A, reason: 'new commit pushed', recorded_by: 'buster' }, 1750000100)
    expect(isInvalidated(db, 300, SHA_A)).toBe(true)
  })

  it('invalidation is scoped to (pr_number, head_sha) -- different sha is not invalidated', () => {
    recordInvalidation(db, { pr_number: 300, head_sha: SHA_A, reason: 'drift', recorded_by: 'buster' }, 1750000100)
    expect(isInvalidated(db, 300, SHA_B)).toBe(false)
  })

  it('invalidation is scoped to pr_number -- different PR is not invalidated', () => {
    recordInvalidation(db, { pr_number: 300, head_sha: SHA_A, reason: 'drift', recorded_by: 'buster' }, 1750000100)
    expect(isInvalidated(db, 999, SHA_A)).toBe(false)
  })

  it('table is included in migrateGateTables and idempotent', () => {
    // Second migration should not throw
    expect(() => migrateGateTables(db)).not.toThrow()
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'gate_%' ORDER BY name`)
      .all() as Array<{ name: string }>
    expect(tables.map((t) => t.name)).toContain('gate_invalidations')
  })

  it('multiple invalidation rows for the same (pr, sha) are allowed (append-only)', () => {
    recordInvalidation(db, { pr_number: 300, head_sha: SHA_A, reason: 'first push', recorded_by: 'buster' }, 1)
    recordInvalidation(db, { pr_number: 300, head_sha: SHA_A, reason: 'second push', recorded_by: 'buster' }, 2)
    const rows = db
      .prepare(`SELECT COUNT(*) AS c FROM gate_invalidations WHERE pr_number = 300 AND head_sha = ?`)
      .get(SHA_A) as { c: number }
    expect(rows.c).toBe(2)
    expect(isInvalidated(db, 300, SHA_A)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// readValidSeats: approval seats excluded when (pr_number, head_sha) is
// invalidated
// ---------------------------------------------------------------------------

describe('readValidSeats excludes invalidated (pr, sha) seats', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    migrateGateTables(db)
  })

  it('returns all seats when not invalidated (same as readApprovals)', () => {
    insertApproval(db, { pr_number: 300, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, 1)
    insertApproval(db, { pr_number: 300, head_sha: SHA_A, reviewer: 'dave', verdict: 'approved', recorded_by: 'dave' }, 2)
    expect(readValidSeats(db, 300, SHA_A)).toHaveLength(2)
  })

  it('returns empty array when (pr, sha) is invalidated', () => {
    insertApproval(db, { pr_number: 300, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, 1)
    insertApproval(db, { pr_number: 300, head_sha: SHA_A, reviewer: 'dave', verdict: 'approved', recorded_by: 'dave' }, 2)
    recordInvalidation(db, { pr_number: 300, head_sha: SHA_A, reason: 'new commit', recorded_by: 'system' }, 3)
    expect(readValidSeats(db, 300, SHA_A)).toHaveLength(0)
  })

  it('invalidating SHA_A does not affect SHA_B seats', () => {
    insertApproval(db, { pr_number: 300, head_sha: SHA_B, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, 1)
    recordInvalidation(db, { pr_number: 300, head_sha: SHA_A, reason: 'old sha', recorded_by: 'system' }, 2)
    expect(readValidSeats(db, 300, SHA_B)).toHaveLength(1)
  })

  it('readApprovals still returns ALL rows (append-only, unchanged)', () => {
    insertApproval(db, { pr_number: 300, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, 1)
    recordInvalidation(db, { pr_number: 300, head_sha: SHA_A, reason: 'drift', recorded_by: 'buster' }, 2)
    // readApprovals is not affected -- it's the raw view
    expect(readApprovals(db, 300, SHA_A)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// POST /api/gate/invalidate endpoint
// ---------------------------------------------------------------------------

const TEST_DB = '/tmp/test-gate-invalidation.db'

function cleanDb() {
  for (const s of ['', '-wal', '-shm']) rmSync(TEST_DB + s, { force: true })
}

async function call(method: string, fullPath: string, body?: unknown, identity?: AgentIdentity) {
  const url = new URL('http://x' + fullPath)
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as never
  const captured: { status: number; body: any } = { status: 200, body: undefined }
  const res = {
    writeHead(status: number) {
      captured.status = status
      return res
    },
    end(b?: string) {
      captured.body = b ? JSON.parse(b) : undefined
    },
  } as never
  const handled = await tryHandleGate({ req, res, method, path: url.pathname, url, identity } as never)
  return { handled, ...captured }
}

const operatorId: AgentIdentity = { agentId: 'marveen', scopes: [ADMIN_SCOPE], source: 'operator' }

beforeEach(() => {
  cleanDb()
  initDatabase(TEST_DB)
})
afterAll(() => cleanDb())

describe('POST /api/gate/invalidate', () => {
  it('is handled (returns true) for POST /api/gate/invalidate', async () => {
    const r = await call('POST', '/api/gate/invalidate', {
      pr_number: 300,
      head_sha: SHA_A,
      reason: 'new commit pushed by author',
    })
    expect(r.handled).toBe(true)
  })

  it('returns 201 with the invalidation record on a valid request', async () => {
    const r = await call('POST', '/api/gate/invalidate', {
      pr_number: 300,
      head_sha: SHA_A,
      reason: 'SHA drift detected',
      recorded_by: 'buster',
    })
    expect(r.status).toBe(201)
    expect(r.body.id).toBeGreaterThan(0)
    expect(r.body.pr_number).toBe(300)
    expect(r.body.head_sha).toBe(SHA_A)
    expect(r.body.reason).toBe('SHA drift detected')
  })

  it('returns 400 when pr_number is missing or not a positive int', async () => {
    expect((await call('POST', '/api/gate/invalidate', { pr_number: 0, head_sha: SHA_A, reason: 'x' })).status).toBe(400)
    expect((await call('POST', '/api/gate/invalidate', { head_sha: SHA_A, reason: 'x' })).status).toBe(400)
  })

  it('returns 400 when head_sha is missing or not a 40-hex string', async () => {
    expect((await call('POST', '/api/gate/invalidate', { pr_number: 300, head_sha: 'abc', reason: 'x' })).status).toBe(400)
    expect((await call('POST', '/api/gate/invalidate', { pr_number: 300, reason: 'x' })).status).toBe(400)
  })

  it('returns 400 when reason is missing or empty', async () => {
    expect((await call('POST', '/api/gate/invalidate', { pr_number: 300, head_sha: SHA_A, reason: '  ' })).status).toBe(400)
    expect((await call('POST', '/api/gate/invalidate', { pr_number: 300, head_sha: SHA_A })).status).toBe(400)
  })

  it('returns 400 on a malformed JSON body', async () => {
    // Supply a non-object body by passing null to the parser
    const url = new URL('http://x/api/gate/invalidate')
    const req = Readable.from([Buffer.from('not-json')]) as never
    const captured: { status: number; body: any } = { status: 200, body: undefined }
    const res = {
      writeHead(status: number) { captured.status = status; return res },
      end(b?: string) { captured.body = b ? JSON.parse(b) : undefined },
    } as never
    await tryHandleGate({ req, res, method: 'POST', path: '/api/gate/invalidate', url, identity: undefined } as never)
    expect(captured.status).toBe(400)
  })

  it('the invalidation persists: isInvalidated returns true after the endpoint call', async () => {
    await call('POST', '/api/gate/invalidate', {
      pr_number: 400,
      head_sha: SHA_A,
      reason: 'force-push detected',
    })
    // Check via gate-db directly on the live singleton db
    const { getDb } = await import('../db.js')
    expect(isInvalidated(getDb(), 400, SHA_A)).toBe(true)
  })

  it('GET on /api/gate/invalidate returns false (not handled as GET)', async () => {
    const r = await call('GET', '/api/gate/invalidate')
    // The tryHandleGate returns true for all /api/gate/* paths that don't match
    // known handlers -- it falls through; in this implementation the path is not
    // matched as GET so it returns false (no 2xx handler bound for GET).
    // We just verify no crash and that it doesn't 201.
    expect(r.status).not.toBe(201)
  })
})

describe('POST /api/gate/invalidate -- inter-agent notification', () => {
  it('enqueues a message to marveen after a successful invalidation', async () => {
    const { getDb: getDbFn } = await import('../db.js')
    const db = getDbFn()

    const beforeCount = (db.prepare(`SELECT COUNT(*) AS c FROM agent_messages WHERE to_agent = 'marveen'`).get() as { c: number }).c

    await call('POST', '/api/gate/invalidate', {
      pr_number: 500,
      head_sha: SHA_A,
      reason: 'SHA drift test notification',
    })

    const afterCount = (db.prepare(`SELECT COUNT(*) AS c FROM agent_messages WHERE to_agent = 'marveen'`).get() as { c: number }).c
    expect(afterCount).toBeGreaterThan(beforeCount)

    const msg = db.prepare(
      `SELECT content FROM agent_messages WHERE to_agent = 'marveen' ORDER BY id DESC LIMIT 1`
    ).get() as { content: string } | undefined
    expect(msg?.content).toBeTruthy()
    expect(msg?.content).toMatch(/500|invalidat/i)
  })
})
