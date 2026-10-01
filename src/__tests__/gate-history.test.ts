// Tests for GET /api/gate/history (card df917696 part c).
// Covers: readGateHistory (db layer) + route handler.

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { Readable } from 'node:stream'
import { rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { migrateGateTables, insertApproval, readGateHistory } from '../web/gate-db.js'
import { initDatabase } from '../db.js'
import { tryHandleGate } from '../web/routes/gate.js'

// ---- DB-layer tests -------------------------------------------------------

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)

describe('readGateHistory (db layer)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    migrateGateTables(db)
  })

  it('returns empty array when no approvals exist', () => {
    expect(readGateHistory(db)).toEqual([])
  })

  it('returns all rows ordered newest-first (recorded_at DESC)', () => {
    insertApproval(db, { pr_number: 10, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, 100)
    insertApproval(db, { pr_number: 20, head_sha: SHA_B, reviewer: 'dave', verdict: 'blocked', recorded_by: 'dave' }, 200)
    insertApproval(db, { pr_number: 30, head_sha: SHA_C, reviewer: 'chad', verdict: 'approved', recorded_by: 'chad' }, 150)

    const rows = readGateHistory(db)
    expect(rows).toHaveLength(3)
    expect(rows[0].pr_number).toBe(20) // recorded_at=200, newest
    expect(rows[1].pr_number).toBe(30) // recorded_at=150
    expect(rows[2].pr_number).toBe(10) // recorded_at=100
  })

  it('filters by pr_number when specified', () => {
    insertApproval(db, { pr_number: 10, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, 100)
    insertApproval(db, { pr_number: 10, head_sha: SHA_B, reviewer: 'dave', verdict: 'approved', recorded_by: 'dave' }, 200)
    insertApproval(db, { pr_number: 99, head_sha: SHA_C, reviewer: 'chad', verdict: 'approved', recorded_by: 'chad' }, 300)

    const rows = readGateHistory(db, { pr: 10 })
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.pr_number === 10)).toBe(true)
  })

  it('respects the limit option', () => {
    for (let i = 0; i < 5; i++) {
      const sha = String(i).repeat(40)
      insertApproval(db, { pr_number: i + 1, head_sha: sha, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, i)
    }
    const rows = readGateHistory(db, { limit: 3 })
    expect(rows).toHaveLength(3)
  })

  it('clamps limit to 1000 (no unbounded reads)', () => {
    // seed 3 rows; requesting limit=99999 should not crash and return <=1000
    for (let i = 0; i < 3; i++) {
      const sha = String(i).repeat(40)
      insertApproval(db, { pr_number: i + 1, head_sha: sha, reviewer: 'dave', verdict: 'approved', recorded_by: 'dave' }, i)
    }
    const rows = readGateHistory(db, { limit: 99999 })
    expect(rows.length).toBeLessThanOrEqual(1000)
    expect(rows).toHaveLength(3) // only 3 exist
  })

  it('returns full row shape (all fields present)', () => {
    insertApproval(db, { pr_number: 5, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor', note: 'lgtm' }, 500)
    const [row] = readGateHistory(db)
    expect(row).toMatchObject({
      id: expect.any(Number),
      pr_number: 5,
      head_sha: SHA_A,
      reviewer: 'thor',
      verdict: 'approved',
      recorded_by: 'thor',
      recorded_at: 500,
      note: 'lgtm',
    })
  })
})

// ---- Route tests -----------------------------------------------------------

const TEST_DB = '/tmp/test-gate-history-route.db'

function cleanDb() {
  for (const s of ['', '-wal', '-shm']) rmSync(TEST_DB + s, { force: true })
}

async function call(method: string, fullPath: string) {
  const url = new URL('http://x' + fullPath)
  const req = Readable.from([]) as never
  const captured: { status: number; body: any } = { status: 200, body: undefined }
  const res = {
    writeHead(status: number) { captured.status = status; return res },
    end(b?: string) { captured.body = b ? JSON.parse(b) : undefined },
  } as never
  const handled = await tryHandleGate({ req, res, method, path: url.pathname, url } as never)
  return { handled, ...captured }
}

beforeEach(() => {
  cleanDb()
  initDatabase(TEST_DB)
})
afterAll(() => cleanDb())

describe('GET /api/gate/history (route)', () => {
  it('returns 200 with rows and count on empty table', async () => {
    const r = await call('GET', '/api/gate/history')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ rows: [], count: 0 })
  })

  it('routes to history and not other gate paths', async () => {
    const r = await call('GET', '/api/gate/other-path')
    expect(r.handled).toBe(false)
  })

  it('rejects a non-positive pr query param with 400', async () => {
    const r = await call('GET', '/api/gate/history?pr=0')
    expect(r.status).toBe(400)
  })

  it('rejects a non-numeric pr with 400', async () => {
    const r = await call('GET', '/api/gate/history?pr=foo')
    expect(r.status).toBe(400)
  })

  it('rejects limit=0 with 400', async () => {
    const r = await call('GET', '/api/gate/history?limit=0')
    expect(r.status).toBe(400)
  })

  it('returns rows filtered by ?pr= with seeded data', async () => {
    const { getDb } = await import('../db.js')
    const db = getDb()
    insertApproval(db, { pr_number: 10, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, 100)
    insertApproval(db, { pr_number: 20, head_sha: SHA_B, reviewer: 'dave', verdict: 'blocked', recorded_by: 'dave' }, 200)

    const r = await call('GET', '/api/gate/history?pr=10')
    expect(r.status).toBe(200)
    expect(r.body.rows).toHaveLength(1)
    expect(r.body.rows[0].pr_number).toBe(10)
    expect(r.body.count).toBe(1)
  })

  it('POST to /api/gate/history is rejected (DELETE/PATCH guard is separate; POST falls through)', async () => {
    // The endpoint is GET-only. POST should fall through (not handled) since the
    // handler only matches GET.
    const url = new URL('http://x/api/gate/history')
    const req = Readable.from([]) as never
    const captured: { status: number; body: any } = { status: 200, body: undefined }
    const res = {
      writeHead(status: number) { captured.status = status; return res },
      end(b?: string) { captured.body = b ? JSON.parse(b) : undefined },
    } as never
    const handled = await tryHandleGate({ req, res, method: 'POST', path: url.pathname, url } as never)
    expect(handled).toBe(false)
  })
})
