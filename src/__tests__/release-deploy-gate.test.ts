// Tests for the deploy gate + deploy_release skeleton (card 2efcb439,
// v2-spec-p9-sandbox-release.md §7, slice 2: the Inv-5 shared code path).
//
// deployGate() is the SINGLE predicate both triggers call -- the dashboard manual
// quick-build AND the cron fix-window job -- so there is no separate live code
// path (Inv-5). The gate encodes: strict green (Inv-7a), Boss approval, not
// already deployed, planning-freeze suppression hook (Inv-8, wired in a later
// slice), and the hard rule that a MANUAL quick-build ALWAYS needs a fresh
// Boss-GO click while the fix-window deploys automatically (D2=AUTO; Thor FLAG-6).
//
// deployRelease() is the skeleton that enforces the gate and converges both
// triggers; the real build/restart + canary/auto-rollback (Inv-10) land next.
// All tests use an isolated in-memory DB -- never the live noa.db.

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { migrateReleaseLedger } from '../web/release-ledger.js'
import {
  insertReleaseCandidate,
  recordSandboxVerdict,
  approveRelease,
  deployGate,
  deployRelease,
  getReleaseRow,
} from '../web/release-pipeline.js'

let db: Database.Database
const validMeta = { suite_test_count: 56, min_required_tests: 10 }

beforeEach(() => {
  db = new Database(':memory:')
  migrateReleaseLedger(db)
})

// Build a fully green + Boss-approved candidate ready to deploy. Returns its id.
function approvedGreenCandidate(version = 'v1.0.0+a'): number {
  const id = insertReleaseCandidate(db, { version, gitSha: 'a', builtAt: 1 })
  recordSandboxVerdict(db, id, { result: 'pass', meta: validMeta })
  approveRelease(db, id, 1700000000000)
  return id
}

// ---------------------------------------------------------------------------
// deployGate
// ---------------------------------------------------------------------------

describe('deployGate', () => {
  it('allows an approved+green+undeployed row on the fix-window trigger (D2=AUTO)', () => {
    const id = approvedGreenCandidate()
    const d = deployGate(db, id, { trigger: 'window' })
    expect(d.deployable).toBe(true)
    expect(d.code).toBe('ok')
  })

  it('allows a manual quick-build ONLY with a fresh Boss-GO click', () => {
    const id = approvedGreenCandidate()
    const withClick = deployGate(db, id, { trigger: 'manual', manualBossGoClick: true })
    expect(withClick.deployable).toBe(true)
    expect(withClick.code).toBe('ok')
  })

  it('blocks a manual quick-build with no Boss-GO click (Inv-5 / FLAG-6)', () => {
    const id = approvedGreenCandidate()
    const noClick = deployGate(db, id, { trigger: 'manual' })
    expect(noClick.deployable).toBe(false)
    expect(noClick.code).toBe('manual_requires_boss_go')
  })

  it('blocks an unknown ledger id', () => {
    const d = deployGate(db, 9999, { trigger: 'window' })
    expect(d.deployable).toBe(false)
    expect(d.code).toBe('no_row')
  })

  it('blocks a still-pending (not green) row', () => {
    const id = insertReleaseCandidate(db, { version: 'v2+a', gitSha: 'a', builtAt: 1 })
    const d = deployGate(db, id, { trigger: 'window' })
    expect(d.deployable).toBe(false)
    expect(d.code).toBe('not_green')
  })

  it('blocks a failed row', () => {
    const id = insertReleaseCandidate(db, { version: 'v3+a', gitSha: 'a', builtAt: 1 })
    recordSandboxVerdict(db, id, { result: 'fail', meta: validMeta })
    const d = deployGate(db, id, { trigger: 'window' })
    expect(d.deployable).toBe(false)
    expect(d.code).toBe('not_green')
  })

  it('blocks a green-but-unapproved row', () => {
    const id = insertReleaseCandidate(db, { version: 'v4+a', gitSha: 'a', builtAt: 1 })
    recordSandboxVerdict(db, id, { result: 'pass', meta: validMeta })
    const d = deployGate(db, id, { trigger: 'window' })
    expect(d.deployable).toBe(false)
    expect(d.code).toBe('not_approved')
  })

  it('blocks an already-deployed row (idempotency)', async () => {
    const id = approvedGreenCandidate()
    await deployRelease(db, id, { trigger: 'window' }, { nowMs: 1700000001000, executor: async () => {} })
    const d = deployGate(db, id, { trigger: 'window' })
    expect(d.deployable).toBe(false)
    expect(d.code).toBe('already_deployed')
  })

  it('suppresses deploy when planning-freeze is active, even for an approved+green row (Inv-8)', () => {
    const id = approvedGreenCandidate()
    const d = deployGate(db, id, { trigger: 'window', planningFreezeActive: true })
    expect(d.deployable).toBe(false)
    expect(d.code).toBe('planning_freeze')
  })

  it('planning-freeze suppression wins over a missing manual click', () => {
    const id = approvedGreenCandidate()
    const d = deployGate(db, id, { trigger: 'manual', planningFreezeActive: true })
    expect(d.deployable).toBe(false)
    expect(d.code).toBe('planning_freeze')
  })
})

// ---------------------------------------------------------------------------
// deployRelease (skeleton -- Inv-5 shared convergence point)
// ---------------------------------------------------------------------------

describe('deployRelease', () => {
  it('does not run the executor or mutate the ledger when the gate blocks', async () => {
    const id = approvedGreenCandidate()
    let ran = false
    const res = await deployRelease(
      db,
      id,
      { trigger: 'manual' }, // no Boss-GO click -> gate blocks
      { nowMs: 1700000002000, executor: async () => { ran = true } }
    )
    expect(res.deployed).toBe(false)
    expect(res.gate.code).toBe('manual_requires_boss_go')
    expect(ran).toBe(false)
    expect(getReleaseRow(db, id)?.deployed_at).toBeNull()
  })

  it('runs the executor and stamps the ledger on a window deploy', async () => {
    const id = approvedGreenCandidate()
    let ran = false
    const res = await deployRelease(
      db,
      id,
      { trigger: 'window' },
      { nowMs: 1700000003000, executor: async () => { ran = true } }
    )
    expect(ran).toBe(true)
    expect(res.deployed).toBe(true)
    const row = getReleaseRow(db, id)
    expect(row?.deployed_at).toBe(1700000003000)
    expect(row?.deploy_result).toBe('ok')
    expect(row?.deploy_kind).toBe('window')
  })

  it('records deploy_kind=manual for a clicked manual quick-build', async () => {
    const id = approvedGreenCandidate()
    const res = await deployRelease(
      db,
      id,
      { trigger: 'manual', manualBossGoClick: true },
      { nowMs: 1700000004000, executor: async () => {} }
    )
    expect(res.deployed).toBe(true)
    expect(getReleaseRow(db, id)?.deploy_kind).toBe('manual')
  })

  it('sets prev_version to the previously-deployed version (rollback target, Inv-6)', async () => {
    const first = approvedGreenCandidate('v1.0.0+a')
    await deployRelease(db, first, { trigger: 'window' }, { nowMs: 1700000005000, executor: async () => {} })
    const second = approvedGreenCandidate('v1.1.0+b')
    await deployRelease(db, second, { trigger: 'window' }, { nowMs: 1700000006000, executor: async () => {} })
    expect(getReleaseRow(db, second)?.prev_version).toBe('v1.0.0+a')
  })

  it('records deploy_result=error and does not mark success when the executor throws', async () => {
    const id = approvedGreenCandidate()
    const res = await deployRelease(
      db,
      id,
      { trigger: 'window' },
      { nowMs: 1700000007000, executor: async () => { throw new Error('build failed') } }
    )
    expect(res.deployed).toBe(false)
    expect(res.error).toMatch(/build failed/)
    const row = getReleaseRow(db, id)
    expect(row?.deploy_result).toBe('error')
    expect(row?.deployed_at).toBeNull()
  })

  it('stamps the ledger through the sanctioned path (no flag leak afterwards)', async () => {
    const id = approvedGreenCandidate()
    await deployRelease(db, id, { trigger: 'window' }, { nowMs: 1700000008000, executor: async () => {} })
    // A raw INSERT must still abort -> the deploy stamp cleared its sentinel.
    expect(() => {
      db.prepare("INSERT INTO release_ledger (version, git_sha, built_at) VALUES ('leak', 'l', 1)").run()
    }).toThrow()
  })
})
