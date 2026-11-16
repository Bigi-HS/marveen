// Tests for the live deploy-path driver (card 2efcb439,
// v2-spec-p9-sandbox-release.md §7/§8). Slice 4b: the Inv-8 freeze LIVE-WIRING.
//
// HARD done-condition (Chad #1024 non-blocker, NoA): prove EMPIRICALLY that a
// planning freeze suppresses a deploy THROUGH the live caller -- not just at the
// deployGate unit level. These tests set the REAL freeze source (the flag file /
// a server freeze-API probe) and drive runLiveDeploy, which resolves the freeze
// itself; planningFreezeActive is NEVER injected. This is the guard against the
// "merged but unwired" trap (a predicate present on the live path but never fed).
// STORE_DIR is mocked to a temp dir so the real flag-file read is exercised.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const { storeHolder } = vi.hoisted(() => ({ storeHolder: { dir: '' } }))

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    get STORE_DIR() {
      return storeHolder.dir
    },
  }
})

import { migrateReleaseLedger } from '../web/release-ledger.js'
import {
  insertReleaseCandidate,
  recordSandboxVerdict,
  approveRelease,
  getReleaseRow,
} from '../web/release-pipeline.js'
import { runLiveDeploy } from '../web/release-deploy-driver.js'

const FLAG = 'planning-freeze.enabled'
const validMeta = { suite_test_count: 56, min_required_tests: 10 }
let db: Database.Database

function approvedGreenCandidate(version = 'v1.0.0+a'): number {
  const id = insertReleaseCandidate(db, { version, gitSha: 'a', builtAt: 1 })
  recordSandboxVerdict(db, id, { result: 'pass', meta: validMeta })
  approveRelease(db, id, 1700000000000)
  return id
}

// A complete safety net whose every member throws if reached. If the freeze gate
// lets execution slip past it, one of these turns the test red -- proving the
// suppression happens BEFORE anything can run.
const mustNotRunNet = () => ({
  executor: async () => {
    throw new Error('executor ran during a freeze')
  },
  canary: async () => {
    throw new Error('canary ran during a freeze')
  },
  rollback: async () => {
    throw new Error('rollback ran during a freeze')
  },
  alert: async () => {
    throw new Error('alert ran during a freeze')
  },
})

beforeEach(() => {
  storeHolder.dir = mkdtempSync(join(tmpdir(), 'p9-driver-'))
  db = new Database(':memory:')
  migrateReleaseLedger(db)
})
afterEach(() => {
  rmSync(storeHolder.dir, { recursive: true, force: true })
})

describe('runLiveDeploy - Inv-8 freeze LIVE-WIRING (empirical, through the live caller)', () => {
  it('a planning-freeze flag file SUPPRESSES a window deploy through the live caller (executor never runs)', async () => {
    const id = approvedGreenCandidate()
    writeFileSync(join(storeHolder.dir, FLAG), '1') // the REAL conservative source

    const res = await runLiveDeploy(db, id, { trigger: 'window' }, {
      nowMs: 1700000010000,
      ...mustNotRunNet(),
    })

    expect(res.deployed).toBe(false)
    expect(res.gate.code).toBe('planning_freeze')
    expect(getReleaseRow(db, id)?.deployed_at).toBeNull()
    expect(getReleaseRow(db, id)?.deploy_result).toBeNull()
  })

  it('the SAME approved+green row deploys once the freeze flag is gone (the file, not an unconditional block, drove the suppression)', async () => {
    const id = approvedGreenCandidate()
    // No flag file this run -> clean state.
    let executorRan = false
    const res = await runLiveDeploy(db, id, { trigger: 'window' }, {
      nowMs: 1700000011000,
      executor: async () => {
        executorRan = true
      },
      canary: async () => ({ healthy: true, detail: 'ok' }),
      rollback: async () => {},
      alert: async () => {},
    })

    expect(executorRan).toBe(true)
    expect(res.deployed).toBe(true)
    expect(getReleaseRow(db, id)?.deploy_result).toBe('ok')
  })

  it('an authoritative server freeze-API (reachable + frozen) SUPPRESSES through the live caller too (cron path)', async () => {
    const id = approvedGreenCandidate()
    const res = await runLiveDeploy(db, id, { trigger: 'window' }, {
      nowMs: 1700000012000,
      ...mustNotRunNet(),
      freezeProbe: async () => ({ reachable: true, frozen: true }),
    })

    expect(res.deployed).toBe(false)
    expect(res.gate.code).toBe('planning_freeze')
    expect(getReleaseRow(db, id)?.deployed_at).toBeNull()
  })

  it('a manual quick-build is ALSO freeze-gated through the live caller (freeze wins over the Boss-GO click)', async () => {
    const id = approvedGreenCandidate()
    writeFileSync(join(storeHolder.dir, FLAG), '1')

    const res = await runLiveDeploy(db, id, { trigger: 'manual', manualBossGoClick: true }, {
      nowMs: 1700000013000,
      executor: async () => {
        throw new Error('executor ran during a freeze')
      },
    })

    expect(res.deployed).toBe(false)
    expect(res.gate.code).toBe('planning_freeze')
  })

  it('a clean manual quick-build with a Boss-GO click deploys (non-vacuity: the gate is not blocking everything)', async () => {
    const id = approvedGreenCandidate()
    let executorRan = false
    const res = await runLiveDeploy(db, id, { trigger: 'manual', manualBossGoClick: true }, {
      nowMs: 1700000014000,
      executor: async () => {
        executorRan = true
      },
    })

    expect(executorRan).toBe(true)
    expect(res.deployed).toBe(true)
    expect(getReleaseRow(db, id)?.deploy_kind).toBe('manual')
  })
})
