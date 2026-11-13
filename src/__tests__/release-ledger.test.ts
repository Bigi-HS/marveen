// Tests for the release_ledger schema + trigger guard (card 2efcb439).
// All tests run against an isolated in-memory database so they never touch
// the live noa.db. TDD order: schema assertions first, then constraint checks,
// then the non-vacuous trigger proof.

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { migrateReleaseLedger, beginSanctionedWrite, endSanctionedWrite } from '../web/release-ledger.js'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  migrateReleaseLedger(db)
})

// ---------------------------------------------------------------------------
// 1. Table + indexes exist after migrateReleaseLedger
// ---------------------------------------------------------------------------

describe('migrateReleaseLedger - schema', () => {
  it('creates the release_ledger table', () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='release_ledger'")
      .get()
    expect(row).toBeTruthy()
  })

  it('creates the _release_ledger_sanctioned helper table', () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_release_ledger_sanctioned'")
      .get()
    expect(row).toBeTruthy()
  })

  it('creates idx_rel_deployed index', () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_rel_deployed'")
      .get()
    expect(row).toBeTruthy()
  })

  it('creates idx_rel_version unique index', () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_rel_version'")
      .get()
    expect(row).toBeTruthy()
  })

  it('is idempotent (calling twice does not throw)', () => {
    expect(() => migrateReleaseLedger(db)).not.toThrow()
  })

  it('columns include all expected fields', () => {
    const cols = (db.prepare('PRAGMA table_info(release_ledger)').all() as Array<{ name: string }>)
      .map((c) => c.name)
    const expected = [
      'id', 'version', 'git_sha', 'built_at', 'sandbox_result',
      'sandbox_meta', 'approved_by', 'approved_at', 'deployed_at',
      'deploy_result', 'deploy_kind', 'prev_version',
    ]
    for (const col of expected) {
      expect(cols).toContain(col)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. CHECK constraints: sandbox_result
// ---------------------------------------------------------------------------

describe('sandbox_result CHECK constraint', () => {
  it('accepts pending (the default)', () => {
    beginSanctionedWrite(db)
    expect(() => {
      db.prepare(
        "INSERT INTO release_ledger (version, git_sha, built_at) VALUES ('v1.0.0+abc', 'abc123', 1000)"
      ).run()
    }).not.toThrow()
    endSanctionedWrite(db)
    const row = db
      .prepare("SELECT sandbox_result FROM release_ledger WHERE version='v1.0.0+abc'")
      .get() as { sandbox_result: string }
    expect(row.sandbox_result).toBe('pending')
  })

  it('accepts pass', () => {
    beginSanctionedWrite(db)
    expect(() => {
      db.prepare(
        "INSERT INTO release_ledger (version, git_sha, built_at, sandbox_result) VALUES ('v1.0.1+abc', 'abc124', 1001, 'pass')"
      ).run()
    }).not.toThrow()
    endSanctionedWrite(db)
  })

  it('accepts fail', () => {
    beginSanctionedWrite(db)
    expect(() => {
      db.prepare(
        "INSERT INTO release_ledger (version, git_sha, built_at, sandbox_result) VALUES ('v1.0.2+abc', 'abc125', 1002, 'fail')"
      ).run()
    }).not.toThrow()
    endSanctionedWrite(db)
  })

  it('rejects bogus sandbox_result values', () => {
    beginSanctionedWrite(db)
    expect(() => {
      db.prepare(
        "INSERT INTO release_ledger (version, git_sha, built_at, sandbox_result) VALUES ('v1.0.3+abc', 'abc126', 1003, 'bogus')"
      ).run()
    }).toThrow()
    endSanctionedWrite(db)
  })
})

// ---------------------------------------------------------------------------
// 3. CHECK constraints: approved_by
// ---------------------------------------------------------------------------

describe('approved_by CHECK constraint', () => {
  it('accepts NULL approved_by', () => {
    beginSanctionedWrite(db)
    expect(() => {
      db.prepare(
        "INSERT INTO release_ledger (version, git_sha, built_at) VALUES ('v2.0.0+def', 'def123', 2000)"
      ).run()
    }).not.toThrow()
    endSanctionedWrite(db)
    const row = db
      .prepare("SELECT approved_by FROM release_ledger WHERE version='v2.0.0+def'")
      .get() as { approved_by: string | null }
    expect(row.approved_by).toBeNull()
  })

  it("accepts approved_by='boss'", () => {
    beginSanctionedWrite(db)
    expect(() => {
      db.prepare(
        "INSERT INTO release_ledger (version, git_sha, built_at, approved_by) VALUES ('v2.0.1+def', 'def124', 2001, 'boss')"
      ).run()
    }).not.toThrow()
    endSanctionedWrite(db)
  })

  it("rejects approved_by='Boss' (case-sensitive guard per spec MINOR-1)", () => {
    beginSanctionedWrite(db)
    expect(() => {
      db.prepare(
        "INSERT INTO release_ledger (version, git_sha, built_at, approved_by) VALUES ('v2.0.2+def', 'def125', 2002, 'Boss')"
      ).run()
    }).toThrow()
    endSanctionedWrite(db)
  })

  it("rejects approved_by='alice'", () => {
    beginSanctionedWrite(db)
    expect(() => {
      db.prepare(
        "INSERT INTO release_ledger (version, git_sha, built_at, approved_by) VALUES ('v2.0.3+def', 'def126', 2003, 'alice')"
      ).run()
    }).toThrow()
    endSanctionedWrite(db)
  })
})

// ---------------------------------------------------------------------------
// 4. UNIQUE(version) rejects duplicate versions
// ---------------------------------------------------------------------------

describe('UNIQUE(version) constraint', () => {
  it('rejects a duplicate version', () => {
    beginSanctionedWrite(db)
    db.prepare(
      "INSERT INTO release_ledger (version, git_sha, built_at) VALUES ('v3.0.0+ghi', 'ghi123', 3000)"
    ).run()
    expect(() => {
      db.prepare(
        "INSERT INTO release_ledger (version, git_sha, built_at) VALUES ('v3.0.0+ghi', 'ghi124', 3001)"
      ).run()
    }).toThrow()
    endSanctionedWrite(db)
  })
})

// ---------------------------------------------------------------------------
// 5. Non-vacuous trigger proof: raw INSERT without flag ABORTs;
//    INSERT via sanctioned path succeeds.
// ---------------------------------------------------------------------------

describe('trigger guard (Invariant 7)', () => {
  it('ABORTs a raw INSERT that bypasses the sanctioned flag', () => {
    // No beginSanctionedWrite() call -- simulates a raw sqlite3 CLI write
    expect(() => {
      db.prepare(
        "INSERT INTO release_ledger (version, git_sha, built_at, approved_by, sandbox_result) VALUES ('v9.0.0+raw', 'raw000', 9000, 'boss', 'pass')"
      ).run()
    }).toThrow()
    // Confirm the row was not inserted
    const row = db
      .prepare("SELECT id FROM release_ledger WHERE version='v9.0.0+raw'")
      .get()
    expect(row).toBeUndefined()
  })

  it('ABORTs a raw UPDATE that bypasses the sanctioned flag', () => {
    // First insert via sanctioned path
    beginSanctionedWrite(db)
    db.prepare(
      "INSERT INTO release_ledger (version, git_sha, built_at) VALUES ('v9.1.0+raw', 'raw001', 9001)"
    ).run()
    endSanctionedWrite(db)

    // Now attempt a raw UPDATE (no sanctioned flag)
    expect(() => {
      db.prepare(
        "UPDATE release_ledger SET approved_by='boss', sandbox_result='pass' WHERE version='v9.1.0+raw'"
      ).run()
    }).toThrow()

    // Confirm the row was not modified
    const row = db
      .prepare("SELECT sandbox_result, approved_by FROM release_ledger WHERE version='v9.1.0+raw'")
      .get() as { sandbox_result: string; approved_by: string | null }
    expect(row.sandbox_result).toBe('pending')
    expect(row.approved_by).toBeNull()
  })

  it('allows INSERT through the sanctioned path', () => {
    beginSanctionedWrite(db)
    expect(() => {
      db.prepare(
        "INSERT INTO release_ledger (version, git_sha, built_at, approved_by, sandbox_result) VALUES ('v9.2.0+ok', 'ok000', 9002, 'boss', 'pass')"
      ).run()
    }).not.toThrow()
    endSanctionedWrite(db)

    const row = db
      .prepare("SELECT sandbox_result, approved_by FROM release_ledger WHERE version='v9.2.0+ok'")
      .get() as { sandbox_result: string; approved_by: string }
    expect(row.sandbox_result).toBe('pass')
    expect(row.approved_by).toBe('boss')
  })

  it('allows UPDATE through the sanctioned path', () => {
    beginSanctionedWrite(db)
    db.prepare(
      "INSERT INTO release_ledger (version, git_sha, built_at) VALUES ('v9.3.0+ok', 'ok001', 9003)"
    ).run()
    endSanctionedWrite(db)

    // Now update via sanctioned path
    beginSanctionedWrite(db)
    expect(() => {
      db.prepare(
        "UPDATE release_ledger SET sandbox_result='pass', approved_by='boss' WHERE version='v9.3.0+ok'"
      ).run()
    }).not.toThrow()
    endSanctionedWrite(db)

    const row = db
      .prepare("SELECT sandbox_result, approved_by FROM release_ledger WHERE version='v9.3.0+ok'")
      .get() as { sandbox_result: string; approved_by: string }
    expect(row.sandbox_result).toBe('pass')
    expect(row.approved_by).toBe('boss')
  })

  it('trigger flag is session-scoped: cleared by endSanctionedWrite, raw write after it ABORTs', () => {
    // Open and close a sanctioned window; subsequent raw write must still abort
    beginSanctionedWrite(db)
    db.prepare(
      "INSERT INTO release_ledger (version, git_sha, built_at) VALUES ('v9.4.0+ok', 'ok002', 9004)"
    ).run()
    endSanctionedWrite(db)

    // Flag should now be cleared
    expect(() => {
      db.prepare(
        "INSERT INTO release_ledger (version, git_sha, built_at) VALUES ('v9.5.0+raw', 'raw002', 9005)"
      ).run()
    }).toThrow()
  })
})
