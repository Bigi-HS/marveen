/**
 * Tests for SHA-drift auto-notify (card 1d1a856e).
 *
 * When a PR's live HEAD SHA moves to a new commit AFTER a reviewer already
 * recorded an `approved` seat on the previous SHA, the gate check proactively
 * notifies the affected reviewer(s) exactly once.
 *
 * Coverage:
 *   - Pure detector: computeDriftNotifications (IO-free unit tests).
 *   - DB helpers: readApprovedSeatsByPr, recordDriftNotified, wasDriftNotified.
 *   - Route integration: GET /api/gate/check triggers notifications, deduplicates
 *     across repeated calls, leaves the gate response body unchanged (AC4/AC5).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { Readable } from 'node:stream'
import { rmSync } from 'node:fs'
import BetterSqlite3 from 'better-sqlite3'
import type Database from 'better-sqlite3'
import { initDatabase, getDb, getPendingMessages } from '../db.js'
import { tryHandleGate, __setGatePrFetcher } from '../web/routes/gate.js'
import { insertApproval, migrateGateTables, readApprovedSeatsByPr, recordDriftNotified, wasDriftNotified } from '../web/gate-db.js'
import { computeDriftNotifications, isSuspiciousShaPrefixCollision, type SeatByOldSha } from '../web/gate-check.js'
import type { GithubPrInfo } from '../web/gate-check.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DB = '/tmp/test-gate-drift-notify.db'
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)
// Two DISTINCT full SHAs that SHARE an 8-hex leading prefix (grinding-signature).
const SHA_P1 = '9c469431' + '1'.repeat(32)
const SHA_P2 = '9c469431' + '2'.repeat(32)
const PR = 800

function cleanDb() {
  for (const s of ['', '-wal', '-shm']) rmSync(TEST_DB + s, { force: true })
}

/** Minimal in-memory DB for gate-db unit tests. */
function makeMemDb(): Database.Database {
  const db = new BetterSqlite3(':memory:')
  migrateGateTables(db)
  return db
}

/** Route call helper (mirrors gate-ci-route.test.ts). */
async function call(method: string, fullPath: string, body?: unknown) {
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
  const handled = await tryHandleGate({ req, res, method, path: url.pathname, url } as never)
  return { handled, ...captured }
}

function stubPr(headSha: string) {
  __setGatePrFetcher(async (): Promise<GithubPrInfo> => ({ headSha, files: ['src/db.ts'] }))
}

// ---------------------------------------------------------------------------
// 1. Pure detector: computeDriftNotifications
// ---------------------------------------------------------------------------

describe('computeDriftNotifications (pure, IO-free)', () => {
  it('AC1/AC2: approved on old SHA + different live head => one entry for that reviewer', () => {
    const seats: SeatByOldSha[] = [{ head_sha: SHA_A, reviewer: 'thor' }]
    const result = computeDriftNotifications(seats, SHA_B)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ reviewer: 'thor', old_sha: SHA_A })
  })

  it('AC2: reviewer re-approved on live head => empty (already up to date)', () => {
    // thor approved SHA_A, then approved SHA_B (the new live head) -- no drift
    const seats: SeatByOldSha[] = [
      { head_sha: SHA_A, reviewer: 'thor' },
      { head_sha: SHA_B, reviewer: 'thor' }, // latest is the live head
    ]
    expect(computeDriftNotifications(seats, SHA_B)).toHaveLength(0)
  })

  it('AC2: blocked-only on old SHA => no drift entry (only approved seats qualify)', () => {
    // gate-db readApprovedSeatsByPr already filters: only approved latest-wins
    // rows are returned. If only blocked, seat is never in the input list.
    const seats: SeatByOldSha[] = [] // blocked seat not included by readApprovedSeatsByPr
    expect(computeDriftNotifications(seats, SHA_B)).toHaveLength(0)
  })

  it('approved on live head only => empty', () => {
    const seats: SeatByOldSha[] = [{ head_sha: SHA_B, reviewer: 'dave' }]
    expect(computeDriftNotifications(seats, SHA_B)).toHaveLength(0)
  })

  it('two reviewers on old SHA => two entries', () => {
    const seats: SeatByOldSha[] = [
      { head_sha: SHA_A, reviewer: 'thor' },
      { head_sha: SHA_A, reviewer: 'dave' },
    ]
    const result = computeDriftNotifications(seats, SHA_B)
    expect(result).toHaveLength(2)
    const reviewers = result.map((e) => e.reviewer).sort()
    expect(reviewers).toEqual(['dave', 'thor'])
  })

  it('no seats at all => empty', () => {
    expect(computeDriftNotifications([], SHA_B)).toHaveLength(0)
  })

  it('latest-wins: approve-then-block on same old SHA => NOT in result (gate-db filtered)', () => {
    // If the DB helper is used correctly, approve->block makes the seat blocked,
    // so it is NOT returned by readApprovedSeatsByPr and hence not in input.
    // Detector receives empty => no drift.
    expect(computeDriftNotifications([], SHA_B)).toHaveLength(0)
  })
})

describe('isSuspiciousShaPrefixCollision (pure, IO-free) -- card 7659af50', () => {
  it('true when two DISTINCT SHAs share an 8-hex prefix', () => {
    expect(isSuspiciousShaPrefixCollision(SHA_P1, SHA_P2)).toBe(true)
  })

  it('false when SHAs are equal (not a collision -- same commit)', () => {
    expect(isSuspiciousShaPrefixCollision(SHA_A, SHA_A)).toBe(false)
  })

  it('false when SHAs have different prefixes', () => {
    expect(isSuspiciousShaPrefixCollision(SHA_A, SHA_B)).toBe(false)
  })

  it('respects a custom prefixLen', () => {
    const x = '0123456789' + 'a'.repeat(30)
    const y = '0123456789' + 'b'.repeat(30)
    expect(isSuspiciousShaPrefixCollision(x, y, 10)).toBe(true)
    expect(isSuspiciousShaPrefixCollision(x, y, 11)).toBe(false) // char 11 differs (a vs b)
  })
})

// ---------------------------------------------------------------------------
// 2. gate-db unit: readApprovedSeatsByPr + dedup helpers
// ---------------------------------------------------------------------------

describe('gate-db: readApprovedSeatsByPr', () => {
  let db: Database.Database

  beforeEach(() => { db = makeMemDb() })
  afterEach(() => { db.close() })

  it('returns approved reviewers across all SHAs for a PR', () => {
    insertApproval(db, { pr_number: PR, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, 1000)
    insertApproval(db, { pr_number: PR, head_sha: SHA_A, reviewer: 'dave', verdict: 'approved', recorded_by: 'dave' }, 1001)
    const seats = readApprovedSeatsByPr(db, PR)
    const reviewers = seats.map((s) => s.reviewer).sort()
    expect(reviewers).toEqual(['dave', 'thor'])
    expect(seats.every((s) => s.head_sha === SHA_A)).toBe(true)
  })

  it('latest-wins: approve then block on same SHA => NOT returned', () => {
    insertApproval(db, { pr_number: PR, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, 1000)
    insertApproval(db, { pr_number: PR, head_sha: SHA_A, reviewer: 'thor', verdict: 'blocked',  recorded_by: 'thor' }, 1001)
    expect(readApprovedSeatsByPr(db, PR)).toHaveLength(0)
  })

  it('latest-wins: block then approve on same SHA => returned as approved', () => {
    insertApproval(db, { pr_number: PR, head_sha: SHA_A, reviewer: 'thor', verdict: 'blocked',  recorded_by: 'thor' }, 1000)
    insertApproval(db, { pr_number: PR, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, 1001)
    const seats = readApprovedSeatsByPr(db, PR)
    expect(seats).toHaveLength(1)
    expect(seats[0].reviewer).toBe('thor')
  })

  it('seats for a different PR are not included', () => {
    insertApproval(db, { pr_number: 999, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, 1000)
    expect(readApprovedSeatsByPr(db, PR)).toHaveLength(0)
  })
})

describe('gate-db: recordDriftNotified + wasDriftNotified', () => {
  let db: Database.Database

  beforeEach(() => { db = makeMemDb() })
  afterEach(() => { db.close() })

  it('wasDriftNotified returns false before any record', () => {
    expect(wasDriftNotified(db, PR, SHA_A, SHA_B, 'thor')).toBe(false)
  })

  it('wasDriftNotified returns true after recordDriftNotified', () => {
    recordDriftNotified(db, PR, SHA_A, SHA_B, 'thor', 1000)
    expect(wasDriftNotified(db, PR, SHA_A, SHA_B, 'thor')).toBe(true)
  })

  it('AC3 dedup: second INSERT of same tuple is a no-op (INSERT OR IGNORE)', () => {
    recordDriftNotified(db, PR, SHA_A, SHA_B, 'thor', 1000)
    // Should not throw and should remain true
    recordDriftNotified(db, PR, SHA_A, SHA_B, 'thor', 2000)
    expect(wasDriftNotified(db, PR, SHA_A, SHA_B, 'thor')).toBe(true)
    // Count: only one row despite two inserts
    const c = db.prepare('SELECT COUNT(*) AS c FROM gate_drift_notifications WHERE pr_number=? AND reviewer=?').get(PR, 'thor') as { c: number }
    expect(c.c).toBe(1)
  })

  it('different reviewer = different row', () => {
    recordDriftNotified(db, PR, SHA_A, SHA_B, 'thor', 1000)
    expect(wasDriftNotified(db, PR, SHA_A, SHA_B, 'dave')).toBe(false)
    recordDriftNotified(db, PR, SHA_A, SHA_B, 'dave', 1001)
    expect(wasDriftNotified(db, PR, SHA_A, SHA_B, 'dave')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. Route integration: GET /api/gate/check triggers drift-notify
// ---------------------------------------------------------------------------

describe('route: /api/gate/check drift-notify (card 1d1a856e)', () => {
  beforeEach(() => {
    cleanDb()
    initDatabase(TEST_DB)
  })
  afterEach(() => cleanDb())
  afterAll(() => cleanDb())

  it('AC2/AC6: thor+dave approved SHA_A, live head moves to SHA_B => one message per reviewer', async () => {
    stubPr(SHA_B)
    const db = getDb()
    // Record approvals on the old SHA
    insertApproval(db, { pr_number: PR, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, 1000)
    insertApproval(db, { pr_number: PR, head_sha: SHA_A, reviewer: 'dave', verdict: 'approved', recorded_by: 'dave' }, 1001)

    const r = await call('GET', `/api/gate/check?pr=${PR}`)
    expect(r.status).toBe(200)

    const msgs = getPendingMessages()
    const driftMsgs = msgs.filter((m) => m.from_agent === 'gate' && (m.to_agent === 'thor' || m.to_agent === 'dave'))
    expect(driftMsgs).toHaveLength(2)
    for (const msg of driftMsgs) {
      expect(msg.priority).toMatch(/high|3/) // stored as int or string
      expect(msg.content).toContain(`PR #${PR}`)
      // Card 7659af50: emit the FULL 40-hex SHAs, not an 8-char truncation.
      expect(msg.content).toContain(SHA_A) // AC6 old sha (full 40-hex)
      expect(msg.content).toContain(SHA_B) // AC6 new sha (full 40-hex)
      // old_sha must be a reachable/real full SHA == the seat's stored head_sha,
      // i.e. a 40-hex string, NOT an 8-char prefix or a reconstructed value.
      expect(SHA_A).toMatch(/^[0-9a-f]{40}$/)
      const oldMatch = msg.content.match(/[0-9a-f]{40}/g) ?? []
      expect(oldMatch).toContain(SHA_A)
    }
  })

  it('card 7659af50: reviewer message embeds the FULL 40-hex old_sha (reachability proxy), not a truncated prefix', async () => {
    stubPr(SHA_B)
    const db = getDb()
    insertApproval(db, { pr_number: PR, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, 1000)

    await call('GET', `/api/gate/check?pr=${PR}`)

    const msgs = getPendingMessages()
    const thorMsg = msgs.find((m) => m.from_agent === 'gate' && m.to_agent === 'thor')
    expect(thorMsg).toBeDefined()
    // The emitted 'old' SHA is the seat's stored full head_sha (40-hex), proving
    // we stopped truncating. An 8-char-only message would NOT contain this.
    expect(thorMsg!.content).toContain(SHA_A)
    expect(SHA_A.length).toBe(40)
  })

  it('card 7659af50: grinding prefix-collision => SECURITY ALERT to marveen (both full SHAs, deduped)', async () => {
    // thor approved on SHA_P1; live head moves to SHA_P2 which shares an 8-hex
    // prefix with SHA_P1 but is a DISTINCT commit -> grinding-signature.
    stubPr(SHA_P2)
    const db = getDb()
    insertApproval(db, { pr_number: PR, head_sha: SHA_P1, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, 1000)

    await call('GET', `/api/gate/check?pr=${PR}`)
    await call('GET', `/api/gate/check?pr=${PR}`) // second call: must NOT re-alert

    const msgs = getPendingMessages()
    const alerts = msgs.filter((m) => m.from_agent === 'gate' && m.to_agent === 'marveen')
    expect(alerts).toHaveLength(1) // deduped once per (pr, old_sha, new_sha)
    const a = alerts[0]
    expect(a.content).toContain(`PR #${PR}`)
    expect(a.content).toContain('thor')
    expect(a.content).toContain(SHA_P1) // full old sha
    expect(a.content).toContain(SHA_P2) // full new sha
    expect(a.priority).toMatch(/high|urgent|3|4/)
  })

  it('card 7659af50: distinct non-colliding SHAs => NO marveen security alert', async () => {
    // SHA_A vs SHA_B share NO prefix -> normal drift, no grinding alert.
    stubPr(SHA_B)
    const db = getDb()
    insertApproval(db, { pr_number: PR, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, 1000)

    await call('GET', `/api/gate/check?pr=${PR}`)

    const msgs = getPendingMessages()
    const alerts = msgs.filter((m) => m.from_agent === 'gate' && m.to_agent === 'marveen')
    expect(alerts).toHaveLength(0)
  })

  it('AC3: calling /api/gate/check twice on same live head => exactly one message per reviewer (dedup)', async () => {
    stubPr(SHA_B)
    const db = getDb()
    insertApproval(db, { pr_number: PR, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, 1000)
    insertApproval(db, { pr_number: PR, head_sha: SHA_A, reviewer: 'dave', verdict: 'approved', recorded_by: 'dave' }, 1001)

    await call('GET', `/api/gate/check?pr=${PR}`)
    await call('GET', `/api/gate/check?pr=${PR}`)

    const msgs = getPendingMessages()
    const thorMsgs = msgs.filter((m) => m.from_agent === 'gate' && m.to_agent === 'thor')
    const daveMsgs = msgs.filter((m) => m.from_agent === 'gate' && m.to_agent === 'dave')
    expect(thorMsgs).toHaveLength(1)
    expect(daveMsgs).toHaveLength(1)
  })

  it('AC4/AC5: response body is identical across the two calls (drift-notify is non-fatal / enforcement untouched)', async () => {
    stubPr(SHA_B)
    const db = getDb()
    insertApproval(db, { pr_number: PR, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, 1000)
    insertApproval(db, { pr_number: PR, head_sha: SHA_A, reviewer: 'dave', verdict: 'approved', recorded_by: 'dave' }, 1001)

    const r1 = await call('GET', `/api/gate/check?pr=${PR}`)
    const r2 = await call('GET', `/api/gate/check?pr=${PR}`)

    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    // Core gate fields must be identical
    expect(r1.body.pass).toBe(r2.body.pass)
    expect(r1.body.head_sha).toBe(r2.body.head_sha)
    expect(r1.body.required).toEqual(r2.body.required)
    expect(r1.body.missing).toEqual(r2.body.missing)
  })

  it('AC2: reviewer who already approved the live SHA is NOT notified', async () => {
    stubPr(SHA_B)
    const db = getDb()
    // thor on old SHA, dave on the new live SHA
    insertApproval(db, { pr_number: PR, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, 1000)
    insertApproval(db, { pr_number: PR, head_sha: SHA_B, reviewer: 'dave', verdict: 'approved', recorded_by: 'dave' }, 1001)

    await call('GET', `/api/gate/check?pr=${PR}`)

    const msgs = getPendingMessages()
    const thorMsg = msgs.filter((m) => m.from_agent === 'gate' && m.to_agent === 'thor')
    const daveMsg = msgs.filter((m) => m.from_agent === 'gate' && m.to_agent === 'dave')
    expect(thorMsg).toHaveLength(1) // thor drifted
    expect(daveMsg).toHaveLength(0) // dave is on live head, no notification
  })

  it('AC7: no drift notifications sent when there are no stale approvals', async () => {
    stubPr(SHA_B)
    // No approvals recorded at all
    const before = getPendingMessages().filter((m) => m.from_agent === 'gate')
    await call('GET', `/api/gate/check?pr=${PR}`)
    const after = getPendingMessages().filter((m) => m.from_agent === 'gate')
    expect(after.length).toBe(before.length) // no new gate messages
  })
})
