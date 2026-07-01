// Mechanical merge-gate enforcement -- persistence layer (claudeclaw.db).
//
// Two append-mostly tables hold the gate state: reviewer verdicts
// (`gate_approvals`, strictly append-only -- no UPDATE/DELETE) and Boss-level
// emergency overrides (`gate_overrides`, whose only mutation is the single-use
// `consumed` flip in its documented lifecycle). Every function takes an explicit
// `db` handle so the route layer passes the live singleton while tests run
// against an isolated in-memory database.
//
// See store/specs/merge-gate-enforcement.md (card fa11eb63).

import type Database from 'better-sqlite3'
import type { ApprovalRow } from './gate-check.js'

// MG-AC1 -- additive migration. Pure `CREATE TABLE IF NOT EXISTS` + indexes:
// idempotent on every boot, never rebuilds an existing table, references no
// other table (no FK), so it can never break boot or trip FK-enforced rebuilds.
export function migrateGateTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gate_approvals (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_number   INTEGER NOT NULL,
      head_sha    TEXT NOT NULL,
      reviewer    TEXT NOT NULL,
      verdict     TEXT NOT NULL,
      recorded_by TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      note        TEXT
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_gate_pr_sha ON gate_approvals(pr_number, head_sha)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_gate_reviewer ON gate_approvals(pr_number, reviewer)`)

  db.exec(`
    CREATE TABLE IF NOT EXISTS gate_overrides (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_number   INTEGER NOT NULL,
      head_sha    TEXT NOT NULL,
      reason      TEXT NOT NULL,
      recorded_by TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      consumed    INTEGER NOT NULL DEFAULT 0,
      consumed_at INTEGER
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_gate_override_pr_sha ON gate_overrides(pr_number, head_sha)`)

  // MG-SEC5: track which agent opened each PR so self-approval can be blocked.
  // INSERT OR IGNORE so a PR re-open does not override the original author record.
  db.exec(`
    CREATE TABLE IF NOT EXISTS gate_pr_authors (
      pr_number   INTEGER PRIMARY KEY,
      author_agent TEXT NOT NULL,
      recorded_at  INTEGER NOT NULL
    )
  `)

  // Card 0c166e48: independent pre-gate CI runs (Buster-CI). Append-only and
  // (pr, head_sha)-scoped, exactly like gate_approvals. The summary columns
  // (tsc/tests/diff-stat) are advisory audit data; `status` is the load-bearing
  // gate input. Additive CREATE IF NOT EXISTS, no FK, idempotent on every boot.
  db.exec(`
    CREATE TABLE IF NOT EXISTS gate_ci_runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_number   INTEGER NOT NULL,
      head_sha    TEXT NOT NULL,
      status      TEXT NOT NULL,
      tsc_ok      INTEGER,
      tests_pass  INTEGER,
      tests_fail  INTEGER,
      diff_files  INTEGER,
      insertions  INTEGER,
      deletions   INTEGER,
      recorded_by TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      note        TEXT
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_gate_ci_pr_sha ON gate_ci_runs(pr_number, head_sha)`)
}

// Record the opening agent for a PR (card ec818352, MG-SEC5). INSERT OR IGNORE
// keeps the first record intact if the PR is re-opened by a different caller.
export function insertPrAuthor(db: Database.Database, prNumber: number, authorAgent: string, now: number): void {
  db.prepare(`INSERT OR IGNORE INTO gate_pr_authors (pr_number, author_agent, recorded_at) VALUES (?, ?, ?)`)
    .run(prNumber, authorAgent, now)
}

// Returns the stored author agent for a PR, or null if not recorded (fail-open).
export function readPrAuthor(db: Database.Database, prNumber: number): string | null {
  const row = db.prepare(`SELECT author_agent FROM gate_pr_authors WHERE pr_number = ?`).get(prNumber) as
    | { author_agent: string }
    | undefined
  return row?.author_agent ?? null
}

export interface ApprovalInput {
  pr_number: number
  head_sha: string
  reviewer: string
  verdict: string
  recorded_by: string
  note?: string | null
}

export interface GateApprovalRow {
  id: number
  pr_number: number
  head_sha: string
  reviewer: string
  verdict: string
  recorded_by: string
  recorded_at: number
  note: string | null
}

// Append-only INSERT. `recorded_at` is always server-stamped by the caller
// (epoch seconds), never caller-supplied (MG-AC1).
export function insertApproval(db: Database.Database, input: ApprovalInput, now: number): GateApprovalRow {
  const note = input.note ?? null
  const info = db
    .prepare(
      `INSERT INTO gate_approvals (pr_number, head_sha, reviewer, verdict, recorded_by, recorded_at, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.pr_number, input.head_sha, input.reviewer, input.verdict, input.recorded_by, now, note)
  return {
    id: Number(info.lastInsertRowid),
    pr_number: input.pr_number,
    head_sha: input.head_sha,
    reviewer: input.reviewer,
    verdict: input.verdict,
    recorded_by: input.recorded_by,
    recorded_at: now,
    note,
  }
}

export function readApprovals(db: Database.Database, pr: number, sha: string): ApprovalRow[] {
  return db
    .prepare(
      `SELECT reviewer, verdict, recorded_at FROM gate_approvals
       WHERE pr_number = ? AND head_sha = ? ORDER BY recorded_at ASC, id ASC`,
    )
    .all(pr, sha) as ApprovalRow[]
}

export interface OverrideInput {
  pr_number: number
  head_sha: string
  reason: string
  recorded_by: string
}

export function insertOverride(db: Database.Database, input: OverrideInput, now: number): { id: number } {
  const info = db
    .prepare(
      `INSERT INTO gate_overrides (pr_number, head_sha, reason, recorded_by, recorded_at, consumed)
       VALUES (?, ?, ?, ?, ?, 0)`,
    )
    .run(input.pr_number, input.head_sha, input.reason, input.recorded_by, now)
  return { id: Number(info.lastInsertRowid) }
}

// An override is "active" while at least one row for (pr, sha) is unconsumed.
export function hasActiveOverride(db: Database.Database, pr: number, sha: string): boolean {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM gate_overrides WHERE pr_number = ? AND head_sha = ? AND consumed = 0`)
    .get(pr, sha) as { c: number }
  return row.c > 0
}

export type ConsumeResult = 'consumed' | 'idempotent' | 'notfound'

// MG-AC7 consume lifecycle. `notfound` -> no override row exists for (pr, sha)
// at all (404). `idempotent` -> an override exists but every row is already
// consumed (200, no state change). `consumed` -> flipped an unconsumed row.
export function consumeOverride(db: Database.Database, pr: number, sha: string, now: number): ConsumeResult {
  const rows = db
    .prepare(`SELECT id, consumed FROM gate_overrides WHERE pr_number = ? AND head_sha = ? ORDER BY id DESC`)
    .all(pr, sha) as Array<{ id: number; consumed: number }>
  if (rows.length === 0) return 'notfound'
  const unconsumed = rows.find((r) => r.consumed === 0)
  if (!unconsumed) return 'idempotent'
  db.prepare(`UPDATE gate_overrides SET consumed = 1, consumed_at = ? WHERE id = ?`).run(now, unconsumed.id)
  return 'consumed'
}

// -- Independent pre-gate CI runs (card 0c166e48) --------------------------

export interface CiRunInput {
  pr_number: number
  head_sha: string
  status: string
  tsc_ok?: number | null
  tests_pass?: number | null
  tests_fail?: number | null
  diff_files?: number | null
  insertions?: number | null
  deletions?: number | null
  recorded_by: string
  note?: string | null
}

export interface GateCiRunRow {
  id: number
  pr_number: number
  head_sha: string
  status: string
  tsc_ok: number | null
  tests_pass: number | null
  tests_fail: number | null
  diff_files: number | null
  insertions: number | null
  deletions: number | null
  recorded_by: string
  recorded_at: number
  note: string | null
}

// Append-only INSERT of a CI run. `recorded_at` is always server-stamped by the
// caller (epoch seconds), never caller-supplied. Summary columns default to null.
export function insertCiRun(db: Database.Database, input: CiRunInput, now: number): GateCiRunRow {
  const row: GateCiRunRow = {
    id: 0,
    pr_number: input.pr_number,
    head_sha: input.head_sha,
    status: input.status,
    tsc_ok: input.tsc_ok ?? null,
    tests_pass: input.tests_pass ?? null,
    tests_fail: input.tests_fail ?? null,
    diff_files: input.diff_files ?? null,
    insertions: input.insertions ?? null,
    deletions: input.deletions ?? null,
    recorded_by: input.recorded_by,
    recorded_at: now,
    note: input.note ?? null,
  }
  const info = db
    .prepare(
      `INSERT INTO gate_ci_runs
         (pr_number, head_sha, status, tsc_ok, tests_pass, tests_fail, diff_files, insertions, deletions, recorded_by, recorded_at, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.pr_number,
      row.head_sha,
      row.status,
      row.tsc_ok,
      row.tests_pass,
      row.tests_fail,
      row.diff_files,
      row.insertions,
      row.deletions,
      row.recorded_by,
      row.recorded_at,
      row.note,
    )
  row.id = Number(info.lastInsertRowid)
  return row
}

// Return the LATEST CI run for a (pr, head_sha), or null. Latest = newest
// recorded_at, tie-broken by newest id -- so resolveCiStatus sees latest-wins.
export function readLatestCiRun(db: Database.Database, pr: number, sha: string): GateCiRunRow | null {
  const row = db
    .prepare(
      `SELECT id, pr_number, head_sha, status, tsc_ok, tests_pass, tests_fail, diff_files, insertions, deletions, recorded_by, recorded_at, note
         FROM gate_ci_runs
        WHERE pr_number = ? AND head_sha = ?
        ORDER BY recorded_at DESC, id DESC
        LIMIT 1`,
    )
    .get(pr, sha) as GateCiRunRow | undefined
  return row ?? null
}
