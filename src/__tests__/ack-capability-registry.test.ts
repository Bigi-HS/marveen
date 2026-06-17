import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase, getDb } from '../db.js'
import {
  effectiveAckCapable,
  isDeclarationLive,
  readAckDeclaration,
  declareAckCapability,
  readEffectiveAckCapable,
  ACK_DECLARATION_TTL_MS,
  type AckDeclaration,
} from '../web/ack-capability-registry.js'

// Card 83b7ec10: ACK-capability V2 -- a boot-time capability handshake backed by
// a durable TTL registry, layered ON TOP of the static V1 flag.
//   effective = (a LIVE non-expired declaration is ackCapable) OR (static V1 flag)
// FAIL-CLOSED: an empty or expired registry with no static flag is NOT capable;
// a missing/expired registry must NEVER imply capable.

// Mirror of the additive ack_capability_registry table created in initDatabase
// (src/db.ts). Kept in the test so the migration/DDL can be exercised on a
// throwaway in-memory DB without booting the whole app.
const REGISTRY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ack_capability_registry (
    agent_id        TEXT PRIMARY KEY,
    ack_capable     INTEGER NOT NULL DEFAULT 0,
    declared_at     INTEGER NOT NULL,
    ttl_expires_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ack_capability_ttl ON ack_capability_registry(ttl_expires_at);
`

const T0 = 1_000_000_000_000 // a fixed "now" for deterministic TTL math

function liveDecl(overrides: Partial<AckDeclaration> = {}): AckDeclaration {
  return {
    agentId: 'dave',
    ackCapable: true,
    declaredAt: T0,
    ttlExpiresAt: T0 + ACK_DECLARATION_TTL_MS,
    ...overrides,
  }
}

describe('isDeclarationLive (pure)', () => {
  it('null declaration is never live', () => {
    expect(isDeclarationLive(null, T0)).toBe(false)
  })

  it('present and before expiry -> live', () => {
    expect(isDeclarationLive(liveDecl(), T0 + 1000)).toBe(true)
  })

  it('the expiry boundary is inclusive (now == ttl_expires_at is still live)', () => {
    const d = liveDecl()
    expect(isDeclarationLive(d, d.ttlExpiresAt)).toBe(true)
  })

  it('one ms past expiry -> not live', () => {
    const d = liveDecl()
    expect(isDeclarationLive(d, d.ttlExpiresAt + 1)).toBe(false)
  })
})

describe('effectiveAckCapable (pure, fail-closed)', () => {
  it('live capable declaration -> capable (self-declared, up)', () => {
    expect(effectiveAckCapable(liveDecl({ ackCapable: true }), false, T0)).toBe(true)
  })

  it('expired declaration falls back to the static flag (true)', () => {
    const expired = liveDecl({ ttlExpiresAt: T0 - 1 })
    expect(effectiveAckCapable(expired, true, T0)).toBe(true)
  })

  it('expired declaration with NO static flag -> fail-closed not-capable', () => {
    const expired = liveDecl({ ackCapable: true, ttlExpiresAt: T0 - 1 })
    expect(effectiveAckCapable(expired, false, T0)).toBe(false)
  })

  it('empty registry (no declaration) and NO static flag -> fail-closed not-capable', () => {
    expect(effectiveAckCapable(null, false, T0)).toBe(false)
  })

  it('empty registry but static flag set -> capable via V1 fallback', () => {
    expect(effectiveAckCapable(null, true, T0)).toBe(true)
  })

  it('live declaration that itself declares NOT capable defers to the static flag', () => {
    // A live `ackCapable:false` declaration does not by itself grant capability;
    // V1 can still opt in, but absent V1 it stays fail-closed.
    expect(effectiveAckCapable(liveDecl({ ackCapable: false }), false, T0)).toBe(false)
    expect(effectiveAckCapable(liveDecl({ ackCapable: false }), true, T0)).toBe(true)
  })

  it('a missing/expired registry NEVER implies capable (the load-bearing invariant)', () => {
    // No combination of (null|expired) declaration + falsy static flag yields true.
    const expired = liveDecl({ ackCapable: true, ttlExpiresAt: T0 - 5 })
    for (const decl of [null, expired]) {
      expect(effectiveAckCapable(decl, false, T0)).toBe(false)
    }
  })
})

describe('declareAckCapability + readAckDeclaration (DB round-trip)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(REGISTRY_SCHEMA)
  })

  it('writes then reads back a typed declaration with computed ttl_expires_at', () => {
    declareAckCapability('dave', true, T0, ACK_DECLARATION_TTL_MS, db)
    const got = readAckDeclaration('dave', db)
    expect(got).toEqual({
      agentId: 'dave',
      ackCapable: true,
      declaredAt: T0,
      ttlExpiresAt: T0 + ACK_DECLARATION_TTL_MS,
    })
  })

  it('returns null for an agent with no row (fail-closed read)', () => {
    expect(readAckDeclaration('nobody', db)).toBe(null)
  })

  it('re-declaration UPSERTs (PK on agent_id, no row leak, TTL slides forward)', () => {
    declareAckCapability('dave', true, T0, ACK_DECLARATION_TTL_MS, db)
    declareAckCapability('dave', true, T0 + 50_000, ACK_DECLARATION_TTL_MS, db)
    const rows = db.prepare('SELECT COUNT(*) AS c FROM ack_capability_registry').get() as { c: number }
    expect(rows.c).toBe(1)
    const got = readAckDeclaration('dave', db)!
    expect(got.declaredAt).toBe(T0 + 50_000)
    expect(got.ttlExpiresAt).toBe(T0 + 50_000 + ACK_DECLARATION_TTL_MS)
  })

  it('end-to-end: a live declaration resolves capable; once expired it falls back', () => {
    declareAckCapability('dave', true, T0, ACK_DECLARATION_TTL_MS, db)
    const decl = readAckDeclaration('dave', db)
    // Inside the TTL window -> capable even with no static flag.
    expect(effectiveAckCapable(decl, false, T0 + 1000)).toBe(true)
    // Past the TTL window and no static flag -> fail-closed not-capable.
    expect(effectiveAckCapable(decl, false, T0 + ACK_DECLARATION_TTL_MS + 1)).toBe(false)
  })
})

describe('live initDatabase boot path (the additive migration runs for real)', () => {
  // Boot the REAL schema into an isolated in-memory DB and prove the table the
  // additive migration creates exists and is wired to readEffectiveAckCapable.
  beforeEach(() => {
    process.env.NODE_ENV = 'test'
    initDatabase(':memory:')
  })

  it('creates ack_capability_registry on a fresh boot', () => {
    const db = getDb()
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ack_capability_registry'")
      .get() as { name: string } | undefined
    expect(row?.name).toBe('ack_capability_registry')
  })

  it('re-booting the schema (idempotent migration) keeps prior rows', () => {
    declareAckCapability('__ack_v2_test_agent', true, T0, ACK_DECLARATION_TTL_MS, getDb())
    // A second initDatabase(':memory:') opens a brand-new connection, so re-run
    // the additive DDL on the SAME connection to model an idempotent re-boot.
    const db = getDb()
    expect(() =>
      db.exec("CREATE TABLE IF NOT EXISTS ack_capability_registry (agent_id TEXT PRIMARY KEY, ack_capable INTEGER NOT NULL DEFAULT 0, declared_at INTEGER NOT NULL, ttl_expires_at INTEGER NOT NULL)"),
    ).not.toThrow()
    expect(readAckDeclaration('__ack_v2_test_agent', db)?.ackCapable).toBe(true)
  })

  it('readEffectiveAckCapable: unknown agent + no declaration -> fail-closed not-capable', () => {
    // No static config on disk for this name and no registry row -> false.
    expect(readEffectiveAckCapable('__ack_v2_unknown_agent', T0, getDb())).toBe(false)
  })

  it('readEffectiveAckCapable: a live declaration makes an otherwise-flagless agent capable', () => {
    const db = getDb()
    declareAckCapability('__ack_v2_live_agent', true, T0, ACK_DECLARATION_TTL_MS, db)
    expect(readEffectiveAckCapable('__ack_v2_live_agent', T0 + 1000, db)).toBe(true)
    // Past the TTL and no static flag -> back to fail-closed.
    expect(readEffectiveAckCapable('__ack_v2_live_agent', T0 + ACK_DECLARATION_TTL_MS + 1, db)).toBe(false)
  })
})

describe('ack_capability_registry migration (additive, idempotent on a populated DB)', () => {
  it('re-running the CREATE TABLE IF NOT EXISTS DDL preserves existing rows', () => {
    const db = new Database(':memory:')
    db.exec(REGISTRY_SCHEMA)
    declareAckCapability('dave', true, T0, ACK_DECLARATION_TTL_MS, db)
    declareAckCapability('thor', false, T0, ACK_DECLARATION_TTL_MS, db)
    const before = db.prepare('SELECT COUNT(*) AS c FROM ack_capability_registry').get() as { c: number }
    expect(before.c).toBe(2)

    // Idempotent boot: the additive DDL runs again on the already-populated DB.
    expect(() => db.exec(REGISTRY_SCHEMA)).not.toThrow()

    const after = db.prepare('SELECT COUNT(*) AS c FROM ack_capability_registry').get() as { c: number }
    expect(after.c).toBe(2)
    // Rows are untouched by the no-op re-create.
    expect(readAckDeclaration('dave', db)).toEqual({
      agentId: 'dave',
      ackCapable: true,
      declaredAt: T0,
      ttlExpiresAt: T0 + ACK_DECLARATION_TTL_MS,
    })
  })
})
