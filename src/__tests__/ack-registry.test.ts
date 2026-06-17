import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  migrateAckRegistry,
  clampTtl,
  declareAck,
  isAckCapableInRegistry,
  ACK_TTL_MIN,
  ACK_TTL_MAX,
  ACK_TTL_DEFAULT,
} from '../web/ack-registry.js'

let db: Database.Database
const NOW = 1_750_000_000

beforeEach(() => {
  db = new Database(':memory:')
  migrateAckRegistry(db)
})

describe('migrateAckRegistry', () => {
  it('is idempotent (running twice does not throw)', () => {
    expect(() => {
      migrateAckRegistry(db)
      migrateAckRegistry(db)
    }).not.toThrow()
  })

  it('creates the agent_ack_registry table', () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_ack_registry'")
      .get()
    expect(row).toBeTruthy()
  })
})

describe('clampTtl (AV2-AC5)', () => {
  it('defaults a missing / non-numeric value to 24h', () => {
    expect(clampTtl(undefined)).toBe(ACK_TTL_DEFAULT)
    expect(clampTtl(null)).toBe(ACK_TTL_DEFAULT)
    expect(clampTtl('86400')).toBe(ACK_TTL_DEFAULT)
    expect(clampTtl(NaN)).toBe(ACK_TTL_DEFAULT)
  })

  it('floors a too-small value to the 1h minimum', () => {
    expect(clampTtl(0)).toBe(ACK_TTL_MIN)
    expect(clampTtl(60)).toBe(ACK_TTL_MIN)
    expect(clampTtl(-5)).toBe(ACK_TTL_MIN)
  })

  it('caps a too-large value to the 7d maximum', () => {
    expect(clampTtl(9_999_999)).toBe(ACK_TTL_MAX)
  })

  it('passes a valid in-range value through (floored to integer)', () => {
    expect(clampTtl(7200)).toBe(7200)
    expect(clampTtl(7200.9)).toBe(7200)
  })
})

describe('declareAck (AV2-AC4 upsert, spoof-guard)', () => {
  it('writes a row with the server-stamped declared_at and clamped ttl', () => {
    const decl = declareAck(db, 'dave', 86400, NOW)
    expect(decl).toEqual({ agent_id: 'dave', declared_at: NOW, expires_at: NOW + 86400 })
    const row = db.prepare('SELECT * FROM agent_ack_registry WHERE agent_id = ?').get('dave')
    expect(row).toEqual({ agent_id: 'dave', declared_at: NOW, ttl_seconds: 86400 })
  })

  it('clamps the ttl on write (ttl 0 -> 3600)', () => {
    declareAck(db, 'dave', 0, NOW)
    const row = db.prepare('SELECT ttl_seconds FROM agent_ack_registry WHERE agent_id = ?').get('dave') as {
      ttl_seconds: number
    }
    expect(row.ttl_seconds).toBe(ACK_TTL_MIN)
  })

  it('upserts: a second declare refreshes the row, no duplicate (AV2-AC10)', () => {
    declareAck(db, 'dave', 86400, NOW)
    declareAck(db, 'dave', 86400, NOW + 100)
    const count = db.prepare('SELECT COUNT(*) AS c FROM agent_ack_registry WHERE agent_id = ?').get('dave') as {
      c: number
    }
    expect(count.c).toBe(1)
    const row = db.prepare('SELECT declared_at FROM agent_ack_registry WHERE agent_id = ?').get('dave') as {
      declared_at: number
    }
    expect(row.declared_at).toBe(NOW + 100)
  })
})

describe('isAckCapableInRegistry (AV2-AC2 / AV2-AC3, fail-closed)', () => {
  it('false when no entry exists (fail-closed)', () => {
    expect(isAckCapableInRegistry(db, 'dave', NOW)).toBe(false)
  })

  it('true for a fresh, non-expired entry', () => {
    declareAck(db, 'dave', 3600, NOW)
    expect(isAckCapableInRegistry(db, 'dave', NOW + 1)).toBe(true)
  })

  it('false for an expired entry (declared_at + ttl <= now)', () => {
    declareAck(db, 'dave', 3600, NOW)
    expect(isAckCapableInRegistry(db, 'dave', NOW + 3600)).toBe(false) // exactly at expiry
    expect(isAckCapableInRegistry(db, 'dave', NOW + 4000)).toBe(false) // past expiry
  })

  it('MUST NOT throw on a DB error -- returns false (table missing)', () => {
    const broken = new Database(':memory:') // no migration -> table absent
    expect(() => isAckCapableInRegistry(broken, 'dave', NOW)).not.toThrow()
    expect(isAckCapableInRegistry(broken, 'dave', NOW)).toBe(false)
    broken.close()
  })
})
