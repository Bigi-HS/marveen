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

// ---------------------------------------------------------------------------
// Deploy gate + deploy_release skeleton (slice 2, §7 Inv-5 shared code path)
// ---------------------------------------------------------------------------
//
// deployGate() is the SINGLE deployability predicate. Both triggers call it -- the
// dashboard manual quick-build AND the cron fix-window job -- so there is no
// separate live code path (Inv-5). deployRelease() is the convergence point that
// enforces the gate and, on pass, runs the (injected) deploy executor and stamps
// the ledger through the sanctioned write-path. The real build/restart mechanics
// and the canary + deterministic auto-rollback (Inv-10) land in the next slice,
// wrapping the executor.

export type DeployTrigger = 'window' | 'manual'

export interface DeployGateInput {
  // 'window' = the automatic dawn fix-window job (D2=AUTO, no closing click).
  // 'manual' = a dashboard quick-build, which ALWAYS requires a fresh Boss-GO
  // click (Inv-5 / §2C / Thor FLAG-6) -- the name "manual" must never mean
  // "unattended".
  trigger: DeployTrigger
  // Fresh Boss-GO click confirmation from the dashboard. Required (and only
  // consulted) for the manual trigger.
  manualBossGoClick?: boolean
  // Planning-freeze state (Inv-8). The caller computes this from the conservative
  // source (server freeze-API authoritative, store/.planning-freeze file fallback)
  // -- that wiring lands in a later slice. When true, the gate SKIPs even an
  // approved+green row, because a cron job runs outside the session-chokepoint
  // freeze-scope (PR#880 respawn-leak class).
  planningFreezeActive?: boolean
}

export type DeployGateCode =
  | 'ok'
  | 'no_row'
  | 'already_deployed'
  | 'planning_freeze'
  | 'not_green'
  | 'not_approved'
  | 'manual_requires_boss_go'

export interface DeployGateDecision {
  deployable: boolean
  code: DeployGateCode
  reason: string
}

function gateDecision(code: DeployGateCode, reason: string): DeployGateDecision {
  return { deployable: code === 'ok', code, reason }
}

// The shared deployability predicate. Pure read -- never mutates. Fail-closed:
// anything other than a fully-cleared row returns deployable=false with a
// machine-stable code for logging/telemetry.
export function deployGate(
  db: Database.Database,
  ledgerId: number,
  input: DeployGateInput
): DeployGateDecision {
  const row = getReleaseRow(db, ledgerId)
  if (!row) {
    return gateDecision('no_row', `no release_ledger row for id=${ledgerId}`)
  }
  if (row.deployed_at !== null) {
    return gateDecision('already_deployed', `id=${ledgerId} already deployed at ${row.deployed_at}`)
  }
  // Inv-8: planning-freeze suppresses deploy even for an approved+green row, and
  // wins over the manual-click check -- a freeze is a hard stop, not a prompt.
  if (input.planningFreezeActive) {
    return gateDecision('planning_freeze', `id=${ledgerId} suppressed (planning-freeze)`)
  }
  if (row.sandbox_result !== 'pass') {
    return gateDecision('not_green', `id=${ledgerId} sandbox_result='${row.sandbox_result}' (strict 'pass' required)`)
  }
  if (row.approved_by !== 'boss') {
    return gateDecision('not_approved', `id=${ledgerId} not Boss-approved`)
  }
  if (input.trigger === 'manual' && !input.manualBossGoClick) {
    return gateDecision(
      'manual_requires_boss_go',
      `id=${ledgerId} manual quick-build requires a fresh Boss-GO click (only the fix-window is automatic)`
    )
  }
  return gateDecision('ok', `id=${ledgerId} deployable via ${input.trigger}`)
}

// The executor performs the real build/rsync/restart. It is injected so the
// shared path can be proven in tests and so the canary + auto-rollback slice can
// wrap it without changing this convergence point.
export type DeployExecutor = () => void | Promise<void>

export interface DeployResult {
  deployed: boolean
  gate: DeployGateDecision
  // Set only when the gate passed but the deploy executor itself failed. The
  // ledger row carries deploy_result='error' in that case.
  error?: string
}

// The single deploy convergence point (Inv-5). Enforces the gate; on pass, runs
// the executor and stamps the ledger (deployed_at, deploy_result, deploy_kind,
// prev_version) through the sanctioned write-path. On executor failure, records
// deploy_result='error' and leaves deployed_at NULL (the attempt is not live and
// may be retried). The canary/auto-rollback (Inv-10) wraps the executor next
// slice, able to flip a stamped 'ok' to 'rolled_back'.
export async function deployRelease(
  db: Database.Database,
  ledgerId: number,
  input: DeployGateInput,
  deps: { nowMs: number; executor: DeployExecutor }
): Promise<DeployResult> {
  const gate = deployGate(db, ledgerId, input)
  if (!gate.deployable) {
    return { deployed: false, gate }
  }

  // The version currently live (if any) becomes this deploy's rollback target.
  const prev = db
    .prepare(
      `SELECT version FROM release_ledger
       WHERE deployed_at IS NOT NULL AND deploy_result = 'ok' AND id != ?
       ORDER BY deployed_at DESC LIMIT 1`
    )
    .get(ledgerId) as { version: string } | undefined
  const prevVersion = prev ? prev.version : null

  try {
    await deps.executor()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    sanctioned(db, () => {
      db.prepare('UPDATE release_ledger SET deploy_result = ?, deploy_kind = ? WHERE id = ?').run(
        'error',
        input.trigger,
        ledgerId
      )
    })
    return { deployed: false, gate, error: msg }
  }

  sanctioned(db, () => {
    db.prepare(
      `UPDATE release_ledger
       SET deployed_at = ?, deploy_result = 'ok', deploy_kind = ?, prev_version = ?
       WHERE id = ?`
    ).run(deps.nowMs, input.trigger, prevVersion, ledgerId)
  })
  return { deployed: true, gate }
}
