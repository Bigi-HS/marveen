// Tests for the Inv-10 post-deploy canary + deterministic auto-rollback (card
// 2efcb439, v2-spec-p9-sandbox-release.md §7/§12, slice 3). D2=AUTO removes the
// closing human, so an unhealthy post-deploy signal MUST trigger a machine
// rollback -- no human/LLM judgement. The canary/rollback/alert are injected so
// the logic is proven without touching the live system. Isolated in-memory DB.

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { migrateReleaseLedger } from '../web/release-ledger.js'
import {
  insertReleaseCandidate,
  recordSandboxVerdict,
  approveRelease,
  deployRelease,
  getReleaseRow,
} from '../web/release-pipeline.js'

let db: Database.Database
const validMeta = { suite_test_count: 56, min_required_tests: 10 }

beforeEach(() => {
  db = new Database(':memory:')
  migrateReleaseLedger(db)
})

function approvedGreenCandidate(version = 'v1.0.0+a'): number {
  const id = insertReleaseCandidate(db, { version, gitSha: 'a', builtAt: 1 })
  recordSandboxVerdict(db, id, { result: 'pass', meta: validMeta })
  approveRelease(db, id, 1700000000000)
  return id
}

const healthy = async () => ({ healthy: true, detail: 'all 4 checks ok' })
const unhealthy = async () => ({ healthy: false, detail: '/api/agents 503' })

describe('canary - healthy', () => {
  it('confirms the deploy (deploy_result=ok) and surfaces the canary result', async () => {
    const id = approvedGreenCandidate()
    const res = await deployRelease(db, id, { trigger: 'window' }, {
      nowMs: 1700000010000,
      executor: async () => {},
      canary: healthy,
    })
    expect(res.deployed).toBe(true)
    expect(res.rolledBack).toBeUndefined()
    expect(res.canary?.healthy).toBe(true)
    expect(getReleaseRow(db, id)?.deploy_result).toBe('ok')
  })

  it('runs the canary only AFTER a successful executor (executor throw -> no canary, error)', async () => {
    const id = approvedGreenCandidate()
    let canaryRan = false
    const res = await deployRelease(db, id, { trigger: 'window' }, {
      nowMs: 1700000011000,
      executor: async () => { throw new Error('build failed') },
      canary: async () => { canaryRan = true; return { healthy: true, detail: 'x' } },
    })
    expect(res.deployed).toBe(false)
    expect(res.error).toMatch(/build failed/)
    expect(canaryRan).toBe(false)
    expect(getReleaseRow(db, id)?.deploy_result).toBe('error')
  })
})

describe('canary - unhealthy -> deterministic auto-rollback (Inv-10)', () => {
  it('reverts to prev_version, marks rolled_back, and alerts the Boss', async () => {
    // Establish a previously-live version to roll back TO.
    const first = approvedGreenCandidate('v1.0.0+a')
    await deployRelease(db, first, { trigger: 'window' }, {
      nowMs: 1700000020000, executor: async () => {}, canary: healthy,
    })

    const second = approvedGreenCandidate('v1.1.0+b')
    let rolledBackTo: string | null | undefined
    let alertMsg = ''
    const res = await deployRelease(db, second, { trigger: 'window' }, {
      nowMs: 1700000021000,
      executor: async () => {},
      canary: unhealthy,
      rollback: async (prev) => { rolledBackTo = prev },
      alert: async (m) => { alertMsg = m },
    })

    expect(res.deployed).toBe(false)
    expect(res.rolledBack).toBe(true)
    expect(res.canary?.healthy).toBe(false)
    // rollback was invoked with the previous live version
    expect(rolledBackTo).toBe('v1.0.0+a')
    // ledger reflects the revert
    const row = getReleaseRow(db, second)
    expect(row?.deploy_result).toBe('rolled_back')
    expect(row?.prev_version).toBe('v1.0.0+a')
    // Boss alerted (the explicit exception to quiet-mode), message names the target
    expect(alertMsg).toMatch(/auto-rollback/i)
    expect(alertMsg).toMatch(/v1\.0\.0\+a/)
  })

  it('still rolls back and marks rolled_back even if the rollback fn itself errors', async () => {
    const id = approvedGreenCandidate()
    let alertMsg = ''
    const res = await deployRelease(db, id, { trigger: 'window' }, {
      nowMs: 1700000022000,
      executor: async () => {},
      canary: unhealthy,
      rollback: async () => { throw new Error('rollback.sh missing') },
      alert: async (m) => { alertMsg = m },
    })
    expect(res.rolledBack).toBe(true)
    expect(getReleaseRow(db, id)?.deploy_result).toBe('rolled_back')
    // the alert escalates the rollback failure
    expect(alertMsg).toMatch(/rollback itself errored|rollback\.sh missing/i)
  })

  it('honors a canary supplied on a manual quick-build too', async () => {
    const id = approvedGreenCandidate()
    const res = await deployRelease(db, id, { trigger: 'manual', manualBossGoClick: true }, {
      nowMs: 1700000023000,
      executor: async () => {},
      canary: unhealthy,
      rollback: async () => {},
      alert: async () => {},
    })
    expect(res.rolledBack).toBe(true)
    expect(getReleaseRow(db, id)?.deploy_result).toBe('rolled_back')
  })

  it('leaves no sanctioned-flag leak after a rollback', async () => {
    const id = approvedGreenCandidate()
    await deployRelease(db, id, { trigger: 'window' }, {
      nowMs: 1700000024000, executor: async () => {}, canary: unhealthy,
      rollback: async () => {}, alert: async () => {},
    })
    expect(() => {
      db.prepare("INSERT INTO release_ledger (version, git_sha, built_at) VALUES ('leak', 'l', 1)").run()
    }).toThrow()
  })
})

describe('Inv-10 enforcement: auto fix-window deploy requires a canary', () => {
  it('throws (before the executor runs) if a window deploy has no canary', async () => {
    const id = approvedGreenCandidate()
    let ran = false
    await expect(
      deployRelease(db, id, { trigger: 'window' }, {
        nowMs: 1700000030000,
        executor: async () => { ran = true },
      })
    ).rejects.toThrow(/canary.*Inv-10/i)
    expect(ran).toBe(false)
    expect(getReleaseRow(db, id)?.deployed_at).toBeNull()
  })

  it('allows a manual quick-build without a canary (its net is the Boss-GO click)', async () => {
    const id = approvedGreenCandidate()
    const res = await deployRelease(db, id, { trigger: 'manual', manualBossGoClick: true }, {
      nowMs: 1700000031000,
      executor: async () => {},
    })
    expect(res.deployed).toBe(true)
    expect(getReleaseRow(db, id)?.deploy_result).toBe('ok')
  })
})
