// Tests for POST /api/auth/app-token
// TDD: tests written before implementation (card 61df322a).
// Covers route guard, auth enforcement, JWT generation/verification, revocation.
// All crypto uses a deterministic test secret -- no env reads in tests.

import { describe, it, expect, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import {
  tryHandleAppAuth,
  signAppToken,
  verifyAppToken,
  applyAppTokenMigrations,
  __setSecretSeam,
  __setDbSeam,
  type AppTokenDb,
} from '../web/routes/app-auth.js'
import type { AgentIdentity } from '../web/agent-token-registry.js'
import Database from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const ADMIN_IDENTITY: AgentIdentity = { agentId: 'marveen', scopes: ['admin:*'], source: 'operator' }
const AGENT_IDENTITY: AgentIdentity = { agentId: 'dave', scopes: [], source: 'agent' }
const ANON_IDENTITY: AgentIdentity = { agentId: '', scopes: [], source: 'agent' }
const TEST_SECRET = Buffer.from('test-secret-32-bytes-padded-aaaa')

async function call(method: string, path: string, rawBody?: string, identity: AgentIdentity = ANON_IDENTITY) {
  const url = new URL('http://x' + path)
  const req = Readable.from(rawBody === undefined ? [] : [Buffer.from(rawBody)]) as never
  const captured: { status: number; body: any } = { status: 200, body: undefined }
  const res = {
    writeHead(status: number) { captured.status = status; return res },
    end(b?: string) { captured.body = b ? JSON.parse(b) : undefined },
  } as never
  const handled = await tryHandleAppAuth({ req, res, method, path: url.pathname, url, identity } as never)
  return { handled, ...captured }
}

function makeMemDb(): AppTokenDb {
  const db = new Database(':memory:')
  applyAppTokenMigrations(db)
  return {
    insertToken(jti, issuedAt, expiresAt, label) {
      db.prepare('INSERT INTO app_tokens (jti, issued_at, expires_at, label) VALUES (?, ?, ?, ?)')
        .run(jti, issuedAt, expiresAt, label ?? null)
    },
    isRevoked(jti) {
      const row = db.prepare('SELECT revoked_at FROM app_tokens WHERE jti = ?').get(jti) as { revoked_at: number | null } | undefined
      return row ? row.revoked_at !== null : true
    },
    isKnown(jti) {
      return !!db.prepare('SELECT 1 FROM app_tokens WHERE jti = ?').get(jti)
    },
    revokeToken(jti, now) {
      db.prepare('UPDATE app_tokens SET revoked_at = ? WHERE jti = ?').run(now, jti)
    },
  }
}

afterEach(() => {
  __setSecretSeam(null)
  __setDbSeam(null)
})

// ---------------------------------------------------------------------------
// Route guard
// ---------------------------------------------------------------------------

describe('route guard', () => {
  it('passes through unrelated paths', async () => {
    const r = await call('POST', '/api/auth/login')
    expect(r.handled).toBe(false)
  })

  it('passes through GET on app-token', async () => {
    const r = await call('GET', '/api/auth/app-token')
    expect(r.handled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// POST /api/auth/app-token -- auth guard
// ---------------------------------------------------------------------------

describe('POST /api/auth/app-token -- auth', () => {
  it('rejects anonymous with 403', async () => {
    __setSecretSeam(TEST_SECRET)
    __setDbSeam(makeMemDb())
    const r = await call('POST', '/api/auth/app-token', '{}', ANON_IDENTITY)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(403)
  })

  it('rejects non-admin agent with 403', async () => {
    __setSecretSeam(TEST_SECRET)
    __setDbSeam(makeMemDb())
    const r = await call('POST', '/api/auth/app-token', '{}', AGENT_IDENTITY)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/admin/i)
  })

  it('allows operator (admin:*) to generate a token', async () => {
    __setSecretSeam(TEST_SECRET)
    __setDbSeam(makeMemDb())
    const r = await call('POST', '/api/auth/app-token', '{}', ADMIN_IDENTITY)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(201)
    expect(typeof r.body.token).toBe('string')
    expect(r.body.token.split('.').length).toBe(3)
  })

  it('stores jti in DB on creation', async () => {
    __setSecretSeam(TEST_SECRET)
    const db = makeMemDb()
    __setDbSeam(db)
    const r = await call('POST', '/api/auth/app-token', '{}', ADMIN_IDENTITY)
    const payload = JSON.parse(Buffer.from(r.body.token.split('.')[1], 'base64url').toString())
    expect(db.isKnown(payload.jti)).toBe(true)
  })

  it('returns expires_at in the response', async () => {
    __setSecretSeam(TEST_SECRET)
    __setDbSeam(makeMemDb())
    const r = await call('POST', '/api/auth/app-token', '{}', ADMIN_IDENTITY)
    expect(typeof r.body.expires_at).toBe('number')
    const nowSec = Math.floor(Date.now() / 1000)
    expect(r.body.expires_at).toBeGreaterThan(nowSec + 89 * 24 * 3600)
    expect(r.body.expires_at).toBeLessThan(nowSec + 91 * 24 * 3600)
  })

  it('accepts an optional label field', async () => {
    __setSecretSeam(TEST_SECRET)
    const db = makeMemDb()
    __setDbSeam(db)
    const r = await call('POST', '/api/auth/app-token', JSON.stringify({ label: 'my-phone' }), ADMIN_IDENTITY)
    expect(r.status).toBe(201)
  })
})

// ---------------------------------------------------------------------------
// POST /api/auth/app-token/revoke
// ---------------------------------------------------------------------------

describe('POST /api/auth/app-token/revoke', () => {
  it('passes through GET on revoke', async () => {
    const r = await call('GET', '/api/auth/app-token/revoke')
    expect(r.handled).toBe(false)
  })

  it('rejects non-admin with 403', async () => {
    const r = await call('POST', '/api/auth/app-token/revoke', JSON.stringify({ jti: 'abc' }), AGENT_IDENTITY)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(403)
  })

  it('rejects missing jti with 400', async () => {
    __setSecretSeam(TEST_SECRET)
    __setDbSeam(makeMemDb())
    const r = await call('POST', '/api/auth/app-token/revoke', '{}', ADMIN_IDENTITY)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(400)
  })

  it('revokes a known token', async () => {
    __setSecretSeam(TEST_SECRET)
    const db = makeMemDb()
    __setDbSeam(db)
    const { jti } = signAppToken(TEST_SECRET)
    db.insertToken(jti, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 7776000, null)
    const r = await call('POST', '/api/auth/app-token/revoke', JSON.stringify({ jti }), ADMIN_IDENTITY)
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(db.isRevoked(jti)).toBe(true)
  })

  it('returns 404 for unknown jti', async () => {
    __setSecretSeam(TEST_SECRET)
    __setDbSeam(makeMemDb())
    const r = await call('POST', '/api/auth/app-token/revoke', JSON.stringify({ jti: 'unknown' }), ADMIN_IDENTITY)
    expect(r.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// signAppToken / verifyAppToken (unit tests for the JWT logic)
// ---------------------------------------------------------------------------

describe('signAppToken', () => {
  it('produces a 3-part JWT string', () => {
    const { token } = signAppToken(TEST_SECRET)
    expect(token.split('.').length).toBe(3)
  })

  it('payload sub=app, exp ~90 days from now', () => {
    const before = Math.floor(Date.now() / 1000)
    const { token } = signAppToken(TEST_SECRET)
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    expect(payload.sub).toBe('app')
    expect(payload.exp - payload.iat).toBeGreaterThanOrEqual(89 * 24 * 3600)
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(91 * 24 * 3600)
    expect(payload.iat).toBeGreaterThanOrEqual(before)
    expect(typeof payload.jti).toBe('string')
    expect(payload.jti.length).toBeGreaterThan(0)
  })

  it('each call produces a unique jti', () => {
    const a = signAppToken(TEST_SECRET)
    const b = signAppToken(TEST_SECRET)
    expect(a.jti).not.toBe(b.jti)
  })
})

describe('verifyAppToken', () => {
  it('returns identity for a valid, non-revoked token', () => {
    const db = makeMemDb()
    const { token, jti, expiresAt } = signAppToken(TEST_SECRET)
    db.insertToken(jti, Math.floor(Date.now() / 1000), expiresAt, null)
    const result = verifyAppToken(token, TEST_SECRET, db)
    expect(result).not.toBeNull()
    expect(result!.agentId).toBe('app')
    expect(result!.scopes).toContain('admin:*')
  })

  it('returns null for a tampered token', () => {
    const db = makeMemDb()
    const { token, jti, expiresAt } = signAppToken(TEST_SECRET)
    db.insertToken(jti, Math.floor(Date.now() / 1000), expiresAt, null)
    const parts = token.split('.')
    // Flip one byte in the signature
    const tampered = parts[0] + '.' + parts[1] + '.' + parts[2].slice(0, -2) + 'aa'
    expect(verifyAppToken(tampered, TEST_SECRET, db)).toBeNull()
  })

  it('returns null for an expired token', () => {
    const db = makeMemDb()
    const nowSec = Math.floor(Date.now() / 1000)
    // Build a token with exp in the past
    const { token, jti } = signAppToken(TEST_SECRET, -1)
    db.insertToken(jti, nowSec - 2, nowSec - 1, null)
    expect(verifyAppToken(token, TEST_SECRET, db)).toBeNull()
  })

  it('returns null for a revoked token', () => {
    const db = makeMemDb()
    const { token, jti, expiresAt } = signAppToken(TEST_SECRET)
    const nowSec = Math.floor(Date.now() / 1000)
    db.insertToken(jti, nowSec, expiresAt, null)
    db.revokeToken(jti, nowSec)
    expect(verifyAppToken(token, TEST_SECRET, db)).toBeNull()
  })

  it('returns null for an unknown jti (not in DB)', () => {
    const db = makeMemDb()
    const { token } = signAppToken(TEST_SECRET)
    // Do not insert into DB
    expect(verifyAppToken(token, TEST_SECRET, db)).toBeNull()
  })

  it('returns null for a malformed token string', () => {
    const db = makeMemDb()
    expect(verifyAppToken('not.a.jwt', TEST_SECRET, db)).toBeNull()
    expect(verifyAppToken('', TEST_SECRET, db)).toBeNull()
  })

  it('returns null for wrong secret', () => {
    const db = makeMemDb()
    const { token, jti, expiresAt } = signAppToken(TEST_SECRET)
    db.insertToken(jti, Math.floor(Date.now() / 1000), expiresAt, null)
    const wrongSecret = Buffer.from('wrong-secret-32-bytes-padded-zzz')
    expect(verifyAppToken(token, wrongSecret, db)).toBeNull()
  })
})
