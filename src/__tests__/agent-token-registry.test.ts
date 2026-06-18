import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  migrateAgentTokenTable,
  mintAgentToken,
  resolveAgentIdentity,
  safeResolveAgentIdentity,
  revokeAgentTokens,
  pruneExpiredTokens,
  hashToken,
  hasScope,
  OPERATOR_AGENT_ID,
  ADMIN_SCOPE,
} from '../web/agent-token-registry.js'

const SHARED = 'f'.repeat(64) // stands in for store/.dashboard-token
const NOW = 1_750_000_000_000 // fixed epoch ms

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  migrateAgentTokenTable(db)
})

describe('migrateAgentTokenTable (additive, idempotent)', () => {
  it('creates the table and is a no-op on a second run', () => {
    expect(() => migrateAgentTokenTable(db)).not.toThrow()
    migrateAgentTokenTable(db)
    const rows = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='agent_tokens'`)
      .all() as Array<{ name: string }>
    expect(rows).toHaveLength(1)
  })
})

describe('mintAgentToken / persistence', () => {
  it('returns a raw token but stores ONLY its sha256 (never the plaintext)', () => {
    const { token, tokenSha256 } = mintAgentToken(db, 'dave', ['message:send'], { now: NOW })
    expect(token).toMatch(/^[0-9a-f]{64}$/) // 32 random bytes hex
    expect(tokenSha256).toBe(hashToken(token))
    // The plaintext must not be anywhere in the row.
    const row = db.prepare('SELECT * FROM agent_tokens WHERE agent_id = ?').get('dave') as Record<string, unknown>
    const serialized = JSON.stringify(row)
    expect(serialized).not.toContain(token)
    expect(serialized).toContain(tokenSha256)
  })

  it('stores an absolute expires_at when a ttl is given, null otherwise', () => {
    mintAgentToken(db, 'dave', ['message:send'], { now: NOW, ttlMs: 24 * 60 * 60 * 1000 })
    mintAgentToken(db, 'thor', ['message:send'], { now: NOW }) // no ttl
    const dave = db.prepare('SELECT expires_at FROM agent_tokens WHERE agent_id = ?').get('dave') as { expires_at: number }
    const thor = db.prepare('SELECT expires_at FROM agent_tokens WHERE agent_id = ?').get('thor') as { expires_at: number | null }
    expect(dave.expires_at).toBe(NOW + 24 * 60 * 60 * 1000)
    expect(thor.expires_at).toBeNull()
  })
})

describe('resolveAgentIdentity', () => {
  it('shared token resolves to the operator/admin identity', () => {
    const r = resolveAgentIdentity(db, SHARED, SHARED, NOW)
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(r.identity).toEqual({ agentId: OPERATOR_AGENT_ID, scopes: [ADMIN_SCOPE], source: 'operator' })
  })

  it('a registered per-agent token resolves to that agent + its scopes', () => {
    const { token } = mintAgentToken(db, 'dave', ['message:send', 'memory:delete:own'], { now: NOW })
    const r = resolveAgentIdentity(db, token, SHARED, NOW)
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(r.identity.agentId).toBe('dave')
    expect(r.identity.source).toBe('agent')
    expect(r.identity.scopes).toEqual(['message:send', 'memory:delete:own'])
  })

  it('an unknown token resolves to unknown (-> 401 at the gate)', () => {
    const r = resolveAgentIdentity(db, 'deadbeef'.repeat(8), SHARED, NOW)
    expect(r.kind).toBe('unknown')
  })

  it('an empty / missing bearer resolves to unknown', () => {
    expect(resolveAgentIdentity(db, undefined, SHARED, NOW).kind).toBe('unknown')
    expect(resolveAgentIdentity(db, '', SHARED, NOW).kind).toBe('unknown')
  })

  it('a revoked token resolves to unknown (-> 401), never to its old identity', () => {
    const { token } = mintAgentToken(db, 'dave', ['message:send'], { now: NOW })
    revokeAgentTokens(db, 'dave', NOW)
    const r = resolveAgentIdentity(db, token, SHARED, NOW)
    expect(r.kind).toBe('unknown')
  })

  it('an expired token resolves to expired (caller decides read vs write), not ok', () => {
    const { token } = mintAgentToken(db, 'dave', ['message:send'], { now: NOW, ttlMs: 1000 })
    const r = resolveAgentIdentity(db, token, SHARED, NOW + 5000)
    expect(r.kind).toBe('expired')
    if (r.kind !== 'expired') return
    expect(r.agentId).toBe('dave')
  })

  it('the shared-token compare is exact (a near-miss is unknown, not operator)', () => {
    const almost = SHARED.slice(0, -1) + 'e'
    expect(resolveAgentIdentity(db, almost, SHARED, NOW).kind).toBe('unknown')
  })
})

describe('safeResolveAgentIdentity (resolution failure fails closed)', () => {
  it('an infrastructure error during resolution returns unknown, never pass-through-as-admin', () => {
    const brokenDb = {
      prepare() {
        throw new Error('simulated registry read failure')
      },
    } as unknown as Database.Database
    // A non-shared bearer forces a registry lookup, which throws.
    const r = safeResolveAgentIdentity(brokenDb, 'sometoken'.repeat(4), SHARED, NOW)
    expect(r.kind).toBe('unknown')
  })

  it('still resolves the shared token without touching the registry', () => {
    const brokenDb = {
      prepare() {
        throw new Error('should not be called for the shared token')
      },
    } as unknown as Database.Database
    const r = safeResolveAgentIdentity(brokenDb, SHARED, SHARED, NOW)
    expect(r.kind).toBe('ok')
  })
})

describe('hasScope (exact membership, default-deny, admin sentinel)', () => {
  it('is EXACT membership -- a prefix never satisfies a longer required scope', () => {
    // The canonical confusion attack: a token holding `memory:delete` must NOT
    // pass a `memory:delete:any` check via any startsWith/prefix logic.
    expect(hasScope(['memory:delete'], 'memory:delete:any')).toBe(false)
    expect(hasScope(['memory:delete:any'], 'memory:delete:any')).toBe(true)
    expect(hasScope(['memory'], 'memory:delete')).toBe(false)
  })

  it('empty or absent scope sets are default-deny', () => {
    expect(hasScope([], 'message:send')).toBe(false)
    expect(hasScope(null, 'message:send')).toBe(false)
    expect(hasScope(undefined, 'message:send')).toBe(false)
  })

  it('the admin sentinel grants any scope (exact membership of the admin label)', () => {
    expect(hasScope([ADMIN_SCOPE], 'memory:delete:any')).toBe(true)
    expect(hasScope([ADMIN_SCOPE], 'message:send')).toBe(true)
  })

  it('the admin sentinel is itself an exact literal, not a wildcard prefix', () => {
    // `admin:foo` must NOT be granted by the bare `admin:*` matching logic in
    // reverse, nor should a token scope `admin:read` satisfy `admin:*`.
    expect(hasScope(['admin:read'], ADMIN_SCOPE)).toBe(false)
  })
})

describe('revokeAgentTokens / pruneExpiredTokens (rotation lifecycle)', () => {
  it('revokeAgentTokens marks every live token of an agent revoked and returns the count', () => {
    mintAgentToken(db, 'dave', ['message:send'], { now: NOW })
    mintAgentToken(db, 'dave', ['message:send'], { now: NOW })
    const n = revokeAgentTokens(db, 'dave', NOW)
    expect(n).toBe(2)
    // A second revoke is a no-op (already revoked).
    expect(revokeAgentTokens(db, 'dave', NOW)).toBe(0)
  })

  it('pruneExpiredTokens deletes only rows past expiry, keeps live and no-expiry rows', () => {
    mintAgentToken(db, 'live', ['message:send'], { now: NOW }) // no expiry
    mintAgentToken(db, 'fresh', ['message:send'], { now: NOW, ttlMs: 10_000 })
    mintAgentToken(db, 'stale', ['message:send'], { now: NOW, ttlMs: 1000 })
    const removed = pruneExpiredTokens(db, NOW + 5000)
    expect(removed).toBe(1)
    const left = db.prepare('SELECT agent_id FROM agent_tokens ORDER BY agent_id').all() as Array<{ agent_id: string }>
    expect(left.map((r) => r.agent_id)).toEqual(['fresh', 'live'])
  })
})
