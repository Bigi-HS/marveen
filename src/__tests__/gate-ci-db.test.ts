/**
 * Persistence for the pre-gate independent CI runs (card 0c166e48).
 * gate_ci_runs is append-only and (pr, head_sha)-scoped, mirroring
 * gate_approvals. readLatestCiRun returns the newest run for a (pr, sha) so the
 * pure resolveCiStatus sees latest-run-wins.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  migrateGateTables,
  insertCiRun,
  readLatestCiRun,
} from '../web/gate-db.js'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const PR = 700

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  migrateGateTables(db)
})

const run = (sha: string, status: string, extra: Record<string, unknown> = {}) => ({
  pr_number: PR,
  head_sha: sha,
  status,
  recorded_by: 'buster',
  ...extra,
})

describe('migrateGateTables creates gate_ci_runs (additive, idempotent)', () => {
  it('table exists after migration and second run is a no-op', () => {
    expect(() => migrateGateTables(db)).not.toThrow()
    const t = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='gate_ci_runs'`)
      .get() as { name: string } | undefined
    expect(t?.name).toBe('gate_ci_runs')
  })
})

describe('insertCiRun + readLatestCiRun', () => {
  it('returns null when no run exists for the sha', () => {
    expect(readLatestCiRun(db, PR, SHA_A)).toBeNull()
  })

  it('round-trips the summary fields', () => {
    const row = insertCiRun(
      db,
      run(SHA_A, 'pass', {
        tsc_ok: 1,
        tests_pass: 3511,
        tests_fail: 0,
        diff_files: 2,
        insertions: 221,
        deletions: 3,
        note: 'log:abc',
      }),
      1000,
    )
    expect(row.id).toBeGreaterThan(0)
    const latest = readLatestCiRun(db, PR, SHA_A)
    expect(latest).toMatchObject({
      pr_number: PR,
      head_sha: SHA_A,
      status: 'pass',
      tsc_ok: 1,
      tests_pass: 3511,
      tests_fail: 0,
      diff_files: 2,
      insertions: 221,
      deletions: 3,
      recorded_by: 'buster',
      recorded_at: 1000,
      note: 'log:abc',
    })
  })

  it('latest-run-wins: fail then pass on the SAME sha -> latest pass', () => {
    insertCiRun(db, run(SHA_A, 'fail'), 1000)
    insertCiRun(db, run(SHA_A, 'pass'), 2000)
    expect(readLatestCiRun(db, PR, SHA_A)?.status).toBe('pass')
  })

  it('latest-run-wins: pass then fail on the SAME sha -> latest fail', () => {
    insertCiRun(db, run(SHA_A, 'pass'), 1000)
    insertCiRun(db, run(SHA_A, 'fail'), 2000)
    expect(readLatestCiRun(db, PR, SHA_A)?.status).toBe('fail')
  })

  it('same-timestamp tie broken by insert order (id) -> newest id wins', () => {
    insertCiRun(db, run(SHA_A, 'fail'), 1000)
    insertCiRun(db, run(SHA_A, 'pass'), 1000)
    expect(readLatestCiRun(db, PR, SHA_A)?.status).toBe('pass')
  })

  it('sha isolation: a run on SHA_A is not returned for SHA_B (same-head binding)', () => {
    insertCiRun(db, run(SHA_A, 'pass'), 1000)
    expect(readLatestCiRun(db, PR, SHA_B)).toBeNull()
  })

  it('optional summary fields default to null when omitted', () => {
    insertCiRun(db, run(SHA_A, 'pass'), 1000)
    const latest = readLatestCiRun(db, PR, SHA_A)
    expect(latest?.tests_pass).toBeNull()
    expect(latest?.diff_files).toBeNull()
    expect(latest?.note).toBeNull()
  })
})
