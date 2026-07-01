import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  migrateGateTables,
  insertApproval,
  readApprovals,
  insertOverride,
  hasActiveOverride,
  consumeOverride,
  insertPrAuthor,
  readPrAuthor,
} from '../web/gate-db.js'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  migrateGateTables(db)
})

describe('migrateGateTables (MG-AC1 additive)', () => {
  it('creates all tables including gate_pr_authors and is idempotent', () => {
    expect(() => migrateGateTables(db)).not.toThrow()
    migrateGateTables(db) // second run is a no-op
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'gate_%' ORDER BY name`)
      .all() as Array<{ name: string }>
    expect(tables.map((t) => t.name)).toEqual(['gate_approvals', 'gate_ci_runs', 'gate_overrides', 'gate_pr_authors'])
  })
})

// ---------------------------------------------------------------------------
// gate_pr_authors -- PR author tracking for self-approval block (MG-SEC5)
// ---------------------------------------------------------------------------
describe('insertPrAuthor / readPrAuthor (MG-SEC5)', () => {
  it('inserts and reads back the author for a PR', () => {
    insertPrAuthor(db, 250, 'dave', 1750000000)
    expect(readPrAuthor(db, 250)).toBe('dave')
  })

  it('returns null for an unknown PR', () => {
    expect(readPrAuthor(db, 9999)).toBeNull()
  })

  it('is idempotent on conflict (same PR re-opened does not crash)', () => {
    insertPrAuthor(db, 250, 'dave', 1750000000)
    expect(() => insertPrAuthor(db, 250, 'dave', 1750000001)).not.toThrow()
  })

  it('returns the first recorded author if re-inserted with a different agent', () => {
    // The first PR-open wins; a re-open by a different agent does not override.
    insertPrAuthor(db, 250, 'dave', 1750000000)
    insertPrAuthor(db, 250, 'thor', 1750000001)
    expect(readPrAuthor(db, 250)).toBe('dave')
  })
})

describe('insertApproval / readApprovals (MG-AC1, MG-AC2)', () => {
  it('inserts a row with a server-stamped recorded_at and returns it', () => {
    const row = insertApproval(
      db,
      { pr_number: 207, head_sha: SHA_A, reviewer: 'dave', verdict: 'approved', recorded_by: 'dave', note: 'ok' },
      1750000000,
    )
    expect(row.id).toBeGreaterThan(0)
    expect(row.recorded_at).toBe(1750000000)
    expect(row.note).toBe('ok')
    const rows = readApprovals(db, 207, SHA_A)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ reviewer: 'dave', verdict: 'approved' })
  })

  it('readApprovals scopes strictly to (pr, sha)', () => {
    insertApproval(db, { pr_number: 207, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, 1)
    insertApproval(db, { pr_number: 207, head_sha: SHA_B, reviewer: 'dave', verdict: 'approved', recorded_by: 'dave' }, 2)
    insertApproval(db, { pr_number: 999, head_sha: SHA_A, reviewer: 'dave', verdict: 'approved', recorded_by: 'dave' }, 3)
    expect(readApprovals(db, 207, SHA_A)).toHaveLength(1)
    expect(readApprovals(db, 207, SHA_B)).toHaveLength(1)
  })

  it('allows multiple rows for the same (pr, sha, reviewer) -- append-only', () => {
    insertApproval(db, { pr_number: 207, head_sha: SHA_A, reviewer: 'dave', verdict: 'approved', recorded_by: 'dave' }, 1)
    insertApproval(db, { pr_number: 207, head_sha: SHA_A, reviewer: 'dave', verdict: 'blocked', recorded_by: 'dave' }, 2)
    expect(readApprovals(db, 207, SHA_A)).toHaveLength(2)
  })
})

describe('override lifecycle (MG-AC7)', () => {
  it('insert -> active; consume -> inactive', () => {
    expect(hasActiveOverride(db, 207, SHA_A)).toBe(false)
    const { id } = insertOverride(db, { pr_number: 207, head_sha: SHA_A, reason: 'hotfix', recorded_by: 'marveen' }, 100)
    expect(id).toBeGreaterThan(0)
    expect(hasActiveOverride(db, 207, SHA_A)).toBe(true)

    expect(consumeOverride(db, 207, SHA_A, 200)).toBe('consumed')
    expect(hasActiveOverride(db, 207, SHA_A)).toBe(false)

    const row = db.prepare(`SELECT consumed, consumed_at FROM gate_overrides WHERE id = ?`).get(id) as {
      consumed: number
      consumed_at: number
    }
    expect(row.consumed).toBe(1)
    expect(row.consumed_at).toBe(200)
  })

  it('consume is idempotent: a second consume returns idempotent, no state change', () => {
    insertOverride(db, { pr_number: 207, head_sha: SHA_A, reason: 'hotfix', recorded_by: 'marveen' }, 100)
    expect(consumeOverride(db, 207, SHA_A, 200)).toBe('consumed')
    expect(consumeOverride(db, 207, SHA_A, 300)).toBe('idempotent')
  })

  it('consume on a sha with no override returns notfound (404 path)', () => {
    insertOverride(db, { pr_number: 207, head_sha: SHA_A, reason: 'hotfix', recorded_by: 'marveen' }, 100)
    expect(consumeOverride(db, 207, SHA_B, 200)).toBe('notfound')
    expect(consumeOverride(db, 999, SHA_A, 200)).toBe('notfound')
  })

  it('override is sha-locked: active on SHA_A does not apply to SHA_B', () => {
    insertOverride(db, { pr_number: 207, head_sha: SHA_A, reason: 'hotfix', recorded_by: 'marveen' }, 100)
    expect(hasActiveOverride(db, 207, SHA_A)).toBe(true)
    expect(hasActiveOverride(db, 207, SHA_B)).toBe(false)
  })
})
