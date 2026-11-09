// Tests for recorded_at normalisation in readApprovals (card 68e34140).
//
// Root cause: some older rows were written with Date.now() (13-digit epoch-ms)
// while the current insertApproval path uses nowEpoch() = Math.floor(Date.now()/1000)
// (10-digit epoch-sec). Without normalisation ORDER BY recorded_at ASC places the
// ms-era row LAST (larger raw number) even though it was written EARLIER in wall
// time, causing evaluateApprovals latest-wins logic to surface a stale verdict.

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { migrateGateTables, readApprovals } from '../web/gate-db.js'

const SHA = 'c'.repeat(40)
const PR = 500

// A realistic ms-era timestamp (older wall-clock time, but > 1e12 as a raw integer).
const MS_ERA_RECORDED_AT = 1794175768401 // ~2026-09-08, written as Date.now()
// A newer epoch-sec timestamp (later wall-clock time, 10-digit).
const EPOCH_SEC_RECORDED_AT = 1794176441  // ~2026-09-08 + ~672 s later

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  migrateGateTables(db)
  // Insert directly so we can supply an ms-era recorded_at that insertApproval
  // would not produce (it always calls nowEpoch() which gives epoch-sec).
  db.prepare(
    `INSERT INTO gate_approvals (pr_number, head_sha, reviewer, verdict, recorded_by, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(PR, SHA, 'thor', 'approved', 'thor', MS_ERA_RECORDED_AT) // older, ms-era

  db.prepare(
    `INSERT INTO gate_approvals (pr_number, head_sha, reviewer, verdict, recorded_by, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(PR, SHA, 'dave', 'approved', 'dave', EPOCH_SEC_RECORDED_AT) // newer, epoch-sec
})

describe('readApprovals -- recorded_at normalisation (card 68e34140)', () => {
  it('returns two rows for the (pr, sha) pair', () => {
    const rows = readApprovals(db, PR, SHA)
    expect(rows).toHaveLength(2)
  })

  it('the epoch-sec row (newer) is last in ASC order after normalisation', () => {
    // Correct order (ASC by normalised wall-clock time):
    //   index 0 = thor  (ms-era ~1794175768 s when divided by 1000 -- older)
    //   index 1 = dave  (epoch-sec 1794176441 -- newer)
    const rows = readApprovals(db, PR, SHA)
    expect(rows[0].reviewer).toBe('thor')  // older -> first in ASC
    expect(rows[1].reviewer).toBe('dave')  // newer -> last in ASC
  })

  it('without normalisation the ms-era row would sort LAST (gate-fail reference)', () => {
    // This test documents the BUG that was present before the fix.
    // Raw values: MS_ERA_RECORDED_AT (1794175768401) > EPOCH_SEC_RECORDED_AT (1794176441)
    // so ORDER BY recorded_at ASC without normalisation would put thor LAST,
    // making dave's verdict (at index 0) appear to be overridden by thor's (at index 1)
    // which is the WRONG temporal order.
    expect(MS_ERA_RECORDED_AT).toBeGreaterThan(EPOCH_SEC_RECORDED_AT)
    // With the fix applied, the normalised values reverse this:
    const normedMs = Math.floor(MS_ERA_RECORDED_AT / 1000)   // ~1794175768
    const normedSec = EPOCH_SEC_RECORDED_AT                   // ~1794176441
    expect(normedMs).toBeLessThan(normedSec) // older ms row normalises to smaller value
  })

  it('returned recorded_at values are epoch-sec (<=10 digits)', () => {
    const rows = readApprovals(db, PR, SHA)
    for (const row of rows) {
      // A 10-digit epoch-sec is at most ~9_999_999_999 (year 2286).
      // A 13-digit ms value would be > 1e12.
      expect(row.recorded_at).toBeLessThan(1_000_000_000_000)
    }
  })
})
