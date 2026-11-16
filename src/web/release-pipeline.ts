// Release-pipeline sanctioned write API (card 2efcb439,
// v2-spec-p9-sandbox-release.md §4/§7, slice 1: the write-path invariants).
//
// This is the ONLY sanctioned write-path into release_ledger. Every mutating
// function wraps its writes in beginSanctionedWrite/endSanctionedWrite (try/finally)
// so the Inv-7 trigger guard admits them, and encodes the pipeline invariants that
// a raw SQL write could otherwise forge:
//
//   Inv-7a (single synchronous verdict write-path): sandbox_result leaves 'pending'
//           ONLY via recordSandboxVerdict, as the final step of a gate verdict. A row
//           is finalized exactly once; re-finalizing is rejected. There is no early /
//           optimistic 'pass' path for the fix-window job to race.
//   Inv-7b (no vacuous green): a 'pass' verdict whose suite ran fewer than
//           min_required_tests (floor 1) tests is DOWNGRADED to 'fail'. approveRelease
//           additionally refuses to stamp approval on any green-but-vacuous row
//           (defense-in-depth against a tampered/legacy meta).
//   Approval: approved_by='boss' is stamped ONLY on a green (sandbox_result='pass'),
//           non-vacuous row, and only through approveRelease. Time is injected
//           (nowMs) so the stamp is deterministic and testable.
//
// Scope note: deploy_gate()/deploy_release() (the read/deploy side, Inv-5 shared
// code path + canary Inv-10 + freeze Inv-8) are the NEXT slice and build on this.

import type Database from 'better-sqlite3'
import { beginSanctionedWrite, endSanctionedWrite } from './release-ledger.js'

// Minimum number of tests a suite must run for its 'pass' to count (Inv-7b).
const MIN_TEST_FLOOR = 1

export interface SandboxMeta {
  suite_test_count: number
  min_required_tests: number
  [k: string]: unknown
}

export interface ReleaseCandidate {
  version: string
  gitSha: string
  builtAt: number
  sandboxMeta?: SandboxMeta | null
}

export interface SandboxVerdict {
  result: 'pass' | 'fail'
  meta: SandboxMeta
}

export interface ReleaseRow {
  id: number
  version: string
  git_sha: string
  built_at: number
  sandbox_result: 'pending' | 'pass' | 'fail'
  sandbox_meta: string | null
  approved_by: string | null
  approved_at: number | null
  deployed_at: number | null
  deploy_result: string | null
  deploy_kind: string | null
  prev_version: string | null
}

// Run fn inside a sanctioned-write window. The sentinel is always cleared in the
// finally block so the Inv-7 flag never leaks to a later (unsanctioned) write,
// even when fn throws.
function sanctioned<T>(db: Database.Database, fn: () => T): T {
  beginSanctionedWrite(db)
  try {
    return fn()
  } finally {
    endSanctionedWrite(db)
  }
}

// A suite is vacuous if its meta is missing/malformed, its declared minimum is
// below the floor, or it ran fewer tests than its own declared minimum. "A test
// that cannot fail proves nothing" -- a 0-test or broken runner must not pass.
function isVacuous(meta: SandboxMeta | null | undefined): boolean {
  if (!meta) return true
  const n = Number(meta.suite_test_count)
  const min = Number(meta.min_required_tests)
  if (!Number.isFinite(n) || !Number.isFinite(min)) return true
  if (min < MIN_TEST_FLOOR) return true
  return n < min
}

export function getReleaseRow(db: Database.Database, id: number): ReleaseRow | undefined {
  return db.prepare('SELECT * FROM release_ledger WHERE id = ?').get(id) as ReleaseRow | undefined
}

// Create a new release candidate in the 'pending' state. Returns the row id.
// A duplicate version trips the UNIQUE(version) index and surfaces as a throw.
export function insertReleaseCandidate(db: Database.Database, c: ReleaseCandidate): number {
  return sanctioned(db, () => {
    const info = db
      .prepare(
        `INSERT INTO release_ledger (version, git_sha, built_at, sandbox_result, sandbox_meta)
         VALUES (?, ?, ?, 'pending', ?)`
      )
      .run(c.version, c.gitSha, c.builtAt, c.sandboxMeta ? JSON.stringify(c.sandboxMeta) : null)
    return Number(info.lastInsertRowid)
  })
}

// Inv-7a + Inv-7b. The ONLY path that moves sandbox_result off 'pending'. Called
// synchronously as the final step of a gate verdict. Returns the stored result
// ('pass' only for a non-vacuous suite; a vacuous 'pass' is stored as 'fail').
export function recordSandboxVerdict(
  db: Database.Database,
  id: number,
  verdict: SandboxVerdict
): 'pass' | 'fail' {
  return sanctioned(db, () => {
    const row = db
      .prepare('SELECT sandbox_result FROM release_ledger WHERE id = ?')
      .get(id) as { sandbox_result: string } | undefined
    if (!row) {
      throw new Error(`release-pipeline: no release_ledger row for id=${id}`)
    }
    if (row.sandbox_result !== 'pending') {
      throw new Error(
        `release-pipeline: sandbox_result already finalized ('${row.sandbox_result}') for id=${id} ` +
          `-- a verdict is written exactly once (Inv-7a)`
      )
    }
    // Inv-7b: a vacuous 'pass' is not a pass.
    const final: 'pass' | 'fail' =
      verdict.result === 'pass' && isVacuous(verdict.meta) ? 'fail' : verdict.result
    db.prepare('UPDATE release_ledger SET sandbox_result = ?, sandbox_meta = ? WHERE id = ?').run(
      final,
      JSON.stringify(verdict.meta),
      id
    )
    return final
  })
}

// Stamp Boss approval. Succeeds only on a green (sandbox_result='pass'),
// non-vacuous row. approved_by is normalized to the lowercase 'boss' literal the
// CHECK constraint + the deploy gate expect. nowMs is injected for determinism.
export function approveRelease(db: Database.Database, id: number, nowMs: number): void {
  sanctioned(db, () => {
    const row = db
      .prepare('SELECT sandbox_result, sandbox_meta FROM release_ledger WHERE id = ?')
      .get(id) as { sandbox_result: string; sandbox_meta: string | null } | undefined
    if (!row) {
      throw new Error(`release-pipeline: no release_ledger row for id=${id}`)
    }
    if (row.sandbox_result !== 'pass') {
      throw new Error(
        `release-pipeline: cannot approve id=${id} -- sandbox_result='${row.sandbox_result}', ` +
          `approval requires a green sandbox verdict`
      )
    }
    const meta = row.sandbox_meta ? (JSON.parse(row.sandbox_meta) as SandboxMeta) : null
    if (isVacuous(meta)) {
      throw new Error(
        `release-pipeline: cannot approve id=${id} -- green row has a vacuous suite (Inv-7b)`
      )
    }
    db.prepare("UPDATE release_ledger SET approved_by = 'boss', approved_at = ? WHERE id = ?").run(
      nowMs,
      id
    )
  })
}
