import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { Readable } from 'node:stream'
import { rmSync } from 'node:fs'
import { initDatabase, getDb } from '../db.js'
import { emitDashboardEvent } from '../event-bus.js'
import { insertApproval, insertCiRun, insertOverride, insertPrAuthor } from '../web/gate-db.js'
import {
  tryHandleGateBoard,
  computeGateBoard,
  __resetGateBoardCache,
} from '../web/routes/gate-board.js'

const TEST_DB = '/tmp/test-gate-board-route.db'
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

function cleanDb() {
  for (const s of ['', '-wal', '-shm']) rmSync(TEST_DB + s, { force: true })
}

async function call(method: string, fullPath: string) {
  const url = new URL('http://x' + fullPath)
  const req = Readable.from([]) as never
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
  const handled = await tryHandleGateBoard({ req, res, method, path: url.pathname, url } as never)
  return { handled, ...captured }
}

const nowS = () => Math.floor(Date.now() / 1000)

beforeEach(() => {
  cleanDb()
  initDatabase(TEST_DB)
  __resetGateBoardCache()
})
afterAll(() => cleanDb())

describe('GET /api/gate/board -- routing', () => {
  it('does not handle unrelated paths', async () => {
    const r = await call('GET', '/api/gate/check?pr=1')
    expect(r.handled).toBe(false)
  })

  it('rejects non-GET methods on the board path', async () => {
    const r = await call('POST', '/api/gate/board')
    expect(r.handled).toBe(false)
  })

  it('returns an empty board when no gate activity exists', async () => {
    const r = await call('GET', '/api/gate/board')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body.prs).toEqual([])
    expect(typeof r.body.generated_at).toBe('number')
    expect(typeof r.body.ttl_ms).toBe('number')
    expect(typeof r.body.window_days).toBe('number')
  })
})

describe('computeGateBoard -- aggregation', () => {
  it('aggregates a thor+dave approved PR as merge-ready (chad not required, ci advisory)', () => {
    const db = getDb()
    const t = nowS()
    insertPrAuthor(db, 344, 'bigben', t)
    insertApproval(db, { pr_number: 344, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, t)
    insertApproval(db, { pr_number: 344, head_sha: SHA_A, reviewer: 'dave', verdict: 'approved', recorded_by: 'dave' }, t + 1)
    insertCiRun(db, { pr_number: 344, head_sha: SHA_A, status: 'pass', recorded_by: 'buster' }, t + 2)

    const board = computeGateBoard(db, nowS())
    expect(board.prs).toHaveLength(1)
    const pr = board.prs[0]
    expect(pr.pr_number).toBe(344)
    expect(pr.author).toBe('bigben')
    expect(pr.seats).toEqual({ thor: 'approved', gauge: 'none', dave: 'approved', chad: 'none' })
    expect(pr.ci_status).toBe('pass')
    expect(pr.chad_reviewed).toBe(false)
    expect(pr.override_active).toBe(false)
    expect(pr.merge_ready).toBe(true)
  })

  it('a missing dave seat is not merge-ready', () => {
    const db = getDb()
    const t = nowS()
    insertApproval(db, { pr_number: 10, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, t)
    const pr = computeGateBoard(db, nowS()).prs[0]
    expect(pr.seats).toEqual({ thor: 'approved', gauge: 'none', dave: 'none', chad: 'none' })
    expect(pr.merge_ready).toBe(false)
  })

  it('a blocked seat is sticky and blocks merge-ready even after a later approval', () => {
    const db = getDb()
    const t = nowS()
    insertApproval(db, { pr_number: 11, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, t)
    insertApproval(db, { pr_number: 11, head_sha: SHA_A, reviewer: 'dave', verdict: 'blocked', recorded_by: 'dave' }, t + 1)
    insertApproval(db, { pr_number: 11, head_sha: SHA_A, reviewer: 'dave', verdict: 'approved', recorded_by: 'dave' }, t + 2)
    const pr = computeGateBoard(db, nowS()).prs[0]
    expect(pr.seats.dave).toBe('blocked')
    expect(pr.merge_ready).toBe(false)
  })

  it('once chad has reviewed, chad becomes required for merge-ready', () => {
    const db = getDb()
    const t = nowS()
    // thor+dave approved but chad only blocked -> chad required and blocking
    insertApproval(db, { pr_number: 12, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, t)
    insertApproval(db, { pr_number: 12, head_sha: SHA_A, reviewer: 'dave', verdict: 'approved', recorded_by: 'dave' }, t + 1)
    insertApproval(db, { pr_number: 12, head_sha: SHA_A, reviewer: 'chad', verdict: 'blocked', recorded_by: 'chad' }, t + 2)
    const pr = computeGateBoard(db, nowS()).prs[0]
    expect(pr.seats.chad).toBe('blocked')
    expect(pr.chad_reviewed).toBe(true)
    expect(pr.merge_ready).toBe(false)

    // chad approves -> now all three required seats approved -> ready
    insertApproval(db, { pr_number: 12, head_sha: SHA_A, reviewer: 'chad', verdict: 'approved', recorded_by: 'chad' }, t + 3)
    const pr2 = computeGateBoard(db, nowS()).prs[0]
    // blocked is sticky per evaluateApprovals, so chad stays blocked -> still not ready
    expect(pr2.seats.chad).toBe('blocked')
    expect(pr2.merge_ready).toBe(false)
  })

  it('computes seats only at the latest head_sha (a stale-sha approval does not count)', () => {
    const db = getDb()
    const t = nowS()
    // thor+dave approved on the OLD sha
    insertApproval(db, { pr_number: 20, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, t)
    insertApproval(db, { pr_number: 20, head_sha: SHA_A, reviewer: 'dave', verdict: 'approved', recorded_by: 'dave' }, t + 1)
    // a newer push (SHA_B) got a fresh CI run but no approvals yet
    insertCiRun(db, { pr_number: 20, head_sha: SHA_B, status: 'pass', recorded_by: 'buster' }, t + 10)
    const pr = computeGateBoard(db, nowS()).prs[0]
    // seats must reflect SHA_B (empty), NOT the stale SHA_A approvals
    expect(pr.seats).toEqual({ thor: 'none', gauge: 'none', dave: 'none', chad: 'none' })
    expect(pr.merge_ready).toBe(false)
  })

  it('an active override marks the PR merge-ready regardless of missing seats', () => {
    const db = getDb()
    const t = nowS()
    insertOverride(db, { pr_number: 30, head_sha: SHA_A, reason: 'boss emergency', recorded_by: 'marveen' }, t)
    const pr = computeGateBoard(db, nowS()).prs[0]
    expect(pr.override_active).toBe(true)
    expect(pr.merge_ready).toBe(true)
  })

  it('excludes PRs whose latest activity is older than the window', () => {
    const db = getDb()
    const t = nowS()
    const old = t - 999 * 24 * 60 * 60
    insertApproval(db, { pr_number: 40, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, old)
    insertApproval(db, { pr_number: 41, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, t)
    const board = computeGateBoard(db, nowS())
    const prNums = board.prs.map((p) => p.pr_number)
    expect(prNums).toContain(41)
    expect(prNums).not.toContain(40)
  })

  it('orders PRs by pr_number descending', () => {
    const db = getDb()
    const t = nowS()
    for (const n of [5, 100, 42]) {
      insertApproval(db, { pr_number: n, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, t)
    }
    const prNums = computeGateBoard(db, nowS()).prs.map((p) => p.pr_number)
    expect(prNums).toEqual([100, 42, 5])
  })

  it('never leaks head_sha into the serialized payload', async () => {
    const db = getDb()
    const t = nowS()
    insertApproval(db, { pr_number: 50, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, t)
    const r = await call('GET', '/api/gate/board')
    const serialized = JSON.stringify(r.body)
    expect(serialized).not.toContain(SHA_A)
    expect(serialized).not.toContain('head_sha')
  })
})

describe('GET /api/gate/board -- TTL cache', () => {
  it('serves a cached board within the TTL window (a later DB write is not reflected)', async () => {
    const db = getDb()
    const t = nowS()
    insertApproval(db, { pr_number: 60, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, t)
    const first = await call('GET', '/api/gate/board')
    expect(first.body.prs[0].seats.dave).toBe('none')

    // Mutate the DB but do NOT invalidate -> the cache still serves the old snapshot.
    insertApproval(db, { pr_number: 60, head_sha: SHA_A, reviewer: 'dave', verdict: 'approved', recorded_by: 'dave' }, t + 1)
    const second = await call('GET', '/api/gate/board')
    expect(second.body.prs[0].seats.dave).toBe('none')
  })

  it('a gate event invalidates the cache so the next read recomputes', async () => {
    const db = getDb()
    const t = nowS()
    insertApproval(db, { pr_number: 61, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, t)
    await call('GET', '/api/gate/board')

    insertApproval(db, { pr_number: 61, head_sha: SHA_A, reviewer: 'dave', verdict: 'approved', recorded_by: 'dave' }, t + 1)
    emitDashboardEvent({ type: 'gate', id: '61', action: 'approved' })

    const after = await call('GET', '/api/gate/board')
    expect(after.body.prs[0].seats.dave).toBe('approved')
  })

  it('a non-gate event does not invalidate the cache', async () => {
    const db = getDb()
    const t = nowS()
    insertApproval(db, { pr_number: 62, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, t)
    await call('GET', '/api/gate/board')

    insertApproval(db, { pr_number: 62, head_sha: SHA_A, reviewer: 'dave', verdict: 'approved', recorded_by: 'dave' }, t + 1)
    emitDashboardEvent({ type: 'kanban', id: 'x', action: 'moved' })

    const after = await call('GET', '/api/gate/board')
    expect(after.body.prs[0].seats.dave).toBe('none')
  })
})
