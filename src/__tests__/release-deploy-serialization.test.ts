// Tests for the single-live-entry deploy serialization guard (card 2efcb439,
// v2-spec-p9-sandbox-release.md §5 G4 deploy-lock + §12 Verify-16). Slice 4c-5.
//
// G4 (spec §5): "Ugyanez a lock vedi a deployt: a hajnali ablak-job es egy kezi
// gyors-build NEM futhat egyszerre (kulonben a git/dist.backup-* allapoton
// versenyeznenek) -- a deploy_gate() deploy-lockot vesz, a vesztes var."
// Verify-16 (spec §12): "egyideju hajnali+kezi deploy kozul csak egy fut, a masik var."
//
// runLiveDeploy is the single live deploy entry point (Inv-5 convergence). Both
// triggers converge there -- the dawn fix-window ('window') and the dashboard
// manual quick-build ('manual'). Without serialization two concurrent entries
// would interleave their real build / dist.backup-* / git / tmux-restart work and
// corrupt each other. This guard makes the loser WAIT: a second live deploy does
// not start its executor until the first has fully completed. The serialization is
// a PROCESS-wide in-memory mutex on the in-server driver (the dashboard server is a
// single process), independent of which ledger row each deploy targets.

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

import { migrateReleaseLedger } from '../web/release-ledger.js'
import {
  insertReleaseCandidate,
  recordSandboxVerdict,
  approveRelease,
  getReleaseRow,
} from '../web/release-pipeline.js'
import { runLiveDeploy } from '../web/release-deploy-driver.js'

const validMeta = { suite_test_count: 56, min_required_tests: 10 }
let db: Database.Database

function approvedGreenCandidate(version: string): number {
  const id = insertReleaseCandidate(db, { version, gitSha: version, builtAt: 1 })
  recordSandboxVerdict(db, id, { result: 'pass', meta: validMeta })
  approveRelease(db, id, 1700000000000)
  return id
}

// A deferred promise so a test can hold an executor "in flight" and observe
// whether a second concurrent deploy starts before it is released.
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  db = new Database(':memory:')
  migrateReleaseLedger(db)
})

describe('runLiveDeploy - single-live-entry serialization (G4 deploy-lock, Verify-16)', () => {
  it('a second concurrent deploy does NOT start its executor until the first completes (the loser waits)', async () => {
    const idA = approvedGreenCandidate('v1.0.0+a')
    const idB = approvedGreenCandidate('v1.0.1+b')

    const order: string[] = []
    const gateA = deferred()

    // Deploy A: enters its executor, then blocks until we release gateA.
    const pA = runLiveDeploy(db, idA, { trigger: 'window' }, {
      nowMs: 1700000010000,
      executor: async () => {
        order.push('A-start')
        await gateA.promise
        order.push('A-end')
      },
      canary: async () => ({ healthy: true, detail: 'ok' }),
      rollback: async () => {},
      alert: async () => {},
    })

    // Give A a tick to enter its executor and park on the gate.
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))

    // Deploy B launched WHILE A is still in flight.
    const pB = runLiveDeploy(db, idB, { trigger: 'manual', manualBossGoClick: true }, {
      nowMs: 1700000020000,
      executor: async () => {
        order.push('B-start')
      },
    })

    // Let microtasks/timers drain. B must NOT have started -- it is waiting on A.
    await new Promise((r) => setTimeout(r, 0))
    expect(order).toEqual(['A-start'])

    // Release A; both should now complete in order with no interleave.
    gateA.resolve()
    const [resA, resB] = await Promise.all([pA, pB])

    expect(order).toEqual(['A-start', 'A-end', 'B-start'])
    expect(resA.deployed).toBe(true)
    expect(resB.deployed).toBe(true)
    expect(getReleaseRow(db, idA)?.deploy_result).toBe('ok')
    expect(getReleaseRow(db, idB)?.deploy_result).toBe('ok')
  })

  it('serializes even when the first deploy FAILS -- the lock is released so the second still runs', async () => {
    const idA = approvedGreenCandidate('v2.0.0+a')
    const idB = approvedGreenCandidate('v2.0.1+b')

    const order: string[] = []
    const resA = await runLiveDeploy(db, idA, { trigger: 'manual', manualBossGoClick: true }, {
      nowMs: 1700000030000,
      executor: async () => {
        order.push('A')
        throw new Error('build blew up')
      },
    })

    const resB = await runLiveDeploy(db, idB, { trigger: 'manual', manualBossGoClick: true }, {
      nowMs: 1700000040000,
      executor: async () => {
        order.push('B')
      },
    })

    expect(order).toEqual(['A', 'B'])
    expect(resA.deployed).toBe(false)
    expect(resA.error).toContain('build blew up')
    expect(getReleaseRow(db, idA)?.deploy_result).toBe('error')
    // The mutex did not deadlock on A's failure: B deployed.
    expect(resB.deployed).toBe(true)
    expect(getReleaseRow(db, idB)?.deploy_result).toBe('ok')
  })

  it('releases the lock even if the deploy THROWS (gate-level throw, e.g. Inv-10 misconfig) so a later deploy is not deadlocked', async () => {
    const idA = approvedGreenCandidate('v3.0.0+a')
    const idB = approvedGreenCandidate('v3.0.1+b')

    // A 'window' deploy with an incomplete safety net throws before the executor
    // (Inv-10). The serialization wrapper must still release the lock.
    await expect(
      runLiveDeploy(db, idA, { trigger: 'window' }, {
        nowMs: 1700000050000,
        executor: async () => {},
        // no canary/rollback/alert -> deployRelease throws
      })
    ).rejects.toThrow(/Inv-10/)

    let bRan = false
    const resB = await runLiveDeploy(db, idB, { trigger: 'manual', manualBossGoClick: true }, {
      nowMs: 1700000060000,
      executor: async () => {
        bRan = true
      },
    })

    expect(bRan).toBe(true)
    expect(resB.deployed).toBe(true)
  })

  it('a gate-rejected deploy (no executor run) still serializes and releases cleanly', async () => {
    // Not approved -> gate rejects, no executor, but the lock must be taken and
    // released so it neither races nor deadlocks.
    const idA = insertReleaseCandidate(db, { version: 'v4.0.0+a', gitSha: 'a', builtAt: 1 })
    recordSandboxVerdict(db, idA, { result: 'pass', meta: validMeta })
    // deliberately NOT approved
    const idB = approvedGreenCandidate('v4.0.1+b')

    const resA = await runLiveDeploy(db, idA, { trigger: 'manual', manualBossGoClick: true }, {
      nowMs: 1700000070000,
      executor: async () => {
        throw new Error('executor must not run on a rejected gate')
      },
    })
    expect(resA.deployed).toBe(false)
    expect(resA.gate.code).toBe('not_approved')

    let bRan = false
    const resB = await runLiveDeploy(db, idB, { trigger: 'manual', manualBossGoClick: true }, {
      nowMs: 1700000080000,
      executor: async () => {
        bRan = true
      },
    })
    expect(bRan).toBe(true)
    expect(resB.deployed).toBe(true)
  })
})
