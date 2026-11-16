// Tests for the release-pipeline sanctioned write API (card 2efcb439,
// v2-spec-p9-sandbox-release.md §4/§7, slice 1: the write-path invariants).
//
// All tests run against an isolated in-memory database so they never touch the
// live noa.db. The focus is the security contract: a green+approved ledger row
// can ONLY be produced through the enforced API, cannot be vacuous (Inv-7b),
// and sandbox_result leaves 'pending' only via the single synchronous
// verdict write-path (Inv-7a).

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { migrateReleaseLedger, beginSanctionedWrite, endSanctionedWrite } from '../web/release-ledger.js'
import {
  insertReleaseCandidate,
  recordSandboxVerdict,
  approveRelease,
  getReleaseRow,
} from '../web/release-pipeline.js'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  migrateReleaseLedger(db)
})

const validMeta = { suite_test_count: 56, min_required_tests: 10 }

function rawWriteAborts(): boolean {
  // A raw INSERT (no sanctioned flag) must still abort after any API call,
  // proving the finally-block cleared the sentinel (no flag leak).
  try {
    db.prepare(
      "INSERT INTO release_ledger (version, git_sha, built_at) VALUES ('v0.0.0+leak', 'leak', 1)"
    ).run()
    return false
  } catch {
    return true
  }
}

// ---------------------------------------------------------------------------
// insertReleaseCandidate
// ---------------------------------------------------------------------------

describe('insertReleaseCandidate', () => {
  it('creates a pending row through the sanctioned path and returns its id', () => {
    const id = insertReleaseCandidate(db, {
      version: 'v1.0.0+abc',
      gitSha: 'abc123',
      builtAt: 1000,
      sandboxMeta: validMeta,
    })
    expect(id).toBeGreaterThan(0)
    const row = getReleaseRow(db, id)
    expect(row?.sandbox_result).toBe('pending')
    expect(row?.approved_by).toBeNull()
    expect(row?.deployed_at).toBeNull()
    expect(JSON.parse(row!.sandbox_meta as string)).toEqual(validMeta)
  })

  it('persists a null sandbox_meta when none is given', () => {
    const id = insertReleaseCandidate(db, { version: 'v1.0.1+abc', gitSha: 'abc124', builtAt: 1001 })
    expect(getReleaseRow(db, id)?.sandbox_meta).toBeNull()
  })

  it('clears the sanctioned flag afterwards (no leak)', () => {
    insertReleaseCandidate(db, { version: 'v1.0.2+abc', gitSha: 'abc125', builtAt: 1002 })
    expect(rawWriteAborts()).toBe(true)
  })

  it('surfaces a duplicate-version conflict', () => {
    insertReleaseCandidate(db, { version: 'v1.0.3+abc', gitSha: 'abc126', builtAt: 1003 })
    expect(() =>
      insertReleaseCandidate(db, { version: 'v1.0.3+abc', gitSha: 'abc127', builtAt: 1004 })
    ).toThrow()
    // flag must still be cleared even though the write threw
    expect(rawWriteAborts()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// recordSandboxVerdict (Inv-7a single synchronous write-path + Inv-7b vacuous)
// ---------------------------------------------------------------------------

describe('recordSandboxVerdict', () => {
  it('transitions pending -> pass for a non-vacuous suite', () => {
    const id = insertReleaseCandidate(db, { version: 'v2.0.0+a', gitSha: 'a', builtAt: 1 })
    const final = recordSandboxVerdict(db, id, { result: 'pass', meta: validMeta })
    expect(final).toBe('pass')
    expect(getReleaseRow(db, id)?.sandbox_result).toBe('pass')
  })

  it('transitions pending -> fail', () => {
    const id = insertReleaseCandidate(db, { version: 'v2.0.1+a', gitSha: 'a', builtAt: 1 })
    const final = recordSandboxVerdict(db, id, { result: 'fail', meta: validMeta })
    expect(final).toBe('fail')
    expect(getReleaseRow(db, id)?.sandbox_result).toBe('fail')
  })

  it('downgrades a vacuous pass to fail (suite_test_count < min_required_tests)', () => {
    const id = insertReleaseCandidate(db, { version: 'v2.0.2+a', gitSha: 'a', builtAt: 1 })
    const final = recordSandboxVerdict(db, id, {
      result: 'pass',
      meta: { suite_test_count: 0, min_required_tests: 10 },
    })
    expect(final).toBe('fail')
    expect(getReleaseRow(db, id)?.sandbox_result).toBe('fail')
  })

  it('treats min_required_tests < 1 as vacuous and downgrades pass to fail', () => {
    const id = insertReleaseCandidate(db, { version: 'v2.0.3+a', gitSha: 'a', builtAt: 1 })
    const final = recordSandboxVerdict(db, id, {
      result: 'pass',
      meta: { suite_test_count: 5, min_required_tests: 0 },
    })
    expect(final).toBe('fail')
  })

  it('rejects re-finalizing an already-decided row (Inv-7a)', () => {
    const id = insertReleaseCandidate(db, { version: 'v2.0.4+a', gitSha: 'a', builtAt: 1 })
    recordSandboxVerdict(db, id, { result: 'pass', meta: validMeta })
    expect(() => recordSandboxVerdict(db, id, { result: 'pass', meta: validMeta })).toThrow(/finaliz/i)
  })

  it('throws on an unknown ledger id', () => {
    expect(() => recordSandboxVerdict(db, 9999, { result: 'pass', meta: validMeta })).toThrow()
  })

  it('clears the sanctioned flag afterwards (no leak)', () => {
    const id = insertReleaseCandidate(db, { version: 'v2.0.5+a', gitSha: 'a', builtAt: 1 })
    recordSandboxVerdict(db, id, { result: 'pass', meta: validMeta })
    expect(rawWriteAborts()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// approveRelease (stamp approved_by='boss' only on a green non-vacuous row)
// ---------------------------------------------------------------------------

describe('approveRelease', () => {
  it('stamps approved_by=boss + approved_at on a green non-vacuous row', () => {
    const id = insertReleaseCandidate(db, { version: 'v3.0.0+a', gitSha: 'a', builtAt: 1 })
    recordSandboxVerdict(db, id, { result: 'pass', meta: validMeta })
    approveRelease(db, id, 1700000000000)
    const row = getReleaseRow(db, id)
    expect(row?.approved_by).toBe('boss')
    expect(row?.approved_at).toBe(1700000000000)
  })

  it('rejects approving a still-pending row (not green)', () => {
    const id = insertReleaseCandidate(db, { version: 'v3.0.1+a', gitSha: 'a', builtAt: 1 })
    expect(() => approveRelease(db, id, 1700000000000)).toThrow(/green|pending|pass/i)
    expect(getReleaseRow(db, id)?.approved_by).toBeNull()
  })

  it('rejects approving a failed row', () => {
    const id = insertReleaseCandidate(db, { version: 'v3.0.2+a', gitSha: 'a', builtAt: 1 })
    recordSandboxVerdict(db, id, { result: 'fail', meta: validMeta })
    expect(() => approveRelease(db, id, 1700000000000)).toThrow()
    expect(getReleaseRow(db, id)?.approved_by).toBeNull()
  })

  it('rejects approving a green-but-vacuous row (defense-in-depth, Inv-7b)', () => {
    // Simulate a tampered/legacy green row whose meta is vacuous by writing it
    // through the sanctioned ledger helpers directly, then prove approveRelease
    // still refuses to stamp approval on it.
    const id = insertReleaseCandidate(db, { version: 'v3.0.3+a', gitSha: 'a', builtAt: 1 })
    // Force a vacuous-meta pass straight into the row (bypassing recordSandboxVerdict's
    // downgrade) via the sanctioned write helpers to exercise approve's own guard.
    beginSanctionedWrite(db)
    db.prepare("UPDATE release_ledger SET sandbox_result='pass', sandbox_meta=? WHERE id=?")
      .run(JSON.stringify({ suite_test_count: 0, min_required_tests: 1 }), id)
    endSanctionedWrite(db)
    expect(() => approveRelease(db, id, 1700000000000)).toThrow(/vacuous/i)
    expect(getReleaseRow(db, id)?.approved_by).toBeNull()
  })

  it('throws on an unknown ledger id', () => {
    expect(() => approveRelease(db, 9999, 1700000000000)).toThrow()
  })

  it('clears the sanctioned flag afterwards (no leak)', () => {
    const id = insertReleaseCandidate(db, { version: 'v3.0.4+a', gitSha: 'a', builtAt: 1 })
    recordSandboxVerdict(db, id, { result: 'pass', meta: validMeta })
    approveRelease(db, id, 1700000000000)
    expect(rawWriteAborts()).toBe(true)
  })
})
