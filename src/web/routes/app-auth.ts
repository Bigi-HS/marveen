// App-token auth endpoints (card 61df322a, Phase 0B)
//
// POST /api/auth/app-token         -- generate a 90-day JWT for the mobile PWA
// POST /api/auth/app-token/revoke  -- revoke a token by jti
//
// Auth: admin:* scope required for both. The app token itself authenticates API
// requests as the operator identity -- see verifyAppToken() used in web.ts.
//
// JWT: HS256 with a per-installation secret (APP_TOKEN_SECRET env or
// store/.app-token-secret). Pure Node.js crypto, no external library.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { readBody, json } from '../http-helpers.js'
import { hasScope, ADMIN_SCOPE, type AgentIdentity } from '../agent-token-registry.js'
import { logger } from '../../logger.js'
import { getNoaDb } from '../../noa-db.js'
import { PROJECT_ROOT } from '../../config.js'
import { readEnvValue } from '../../env.js'
import type { RouteContext } from './types.js'

const APP_TOKEN_TTL_SECONDS = 90 * 24 * 3600

// ---------------------------------------------------------------------------
// DB interface + seam
// ---------------------------------------------------------------------------

export interface AppTokenDb {
  insertToken(jti: string, issuedAt: number, expiresAt: number, label: string | null): void
  isRevoked(jti: string): boolean
  isKnown(jti: string): boolean
  revokeToken(jti: string, now: number): void
}

let _dbSeam: AppTokenDb | null = null
export function __setDbSeam(db: AppTokenDb | null): void { _dbSeam = db }

class SqliteAppTokenDb implements AppTokenDb {
  constructor(private db: Database.Database) {}

  insertToken(jti: string, issuedAt: number, expiresAt: number, label: string | null): void {
    this.db.prepare(
      `INSERT INTO app_tokens (jti, issued_at, expires_at, label) VALUES (?, ?, ?, ?)`,
    ).run(jti, issuedAt, expiresAt, label)
  }

  isRevoked(jti: string): boolean {
    const row = this.db.prepare('SELECT revoked_at FROM app_tokens WHERE jti = ?').get(jti) as
      | { revoked_at: number | null }
      | undefined
    return row ? row.revoked_at !== null : true
  }

  isKnown(jti: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM app_tokens WHERE jti = ?').get(jti)
  }

  revokeToken(jti: string, now: number): void {
    this.db.prepare('UPDATE app_tokens SET revoked_at = ? WHERE jti = ?').run(now, jti)
  }
}

function getDb(): AppTokenDb {
  if (_dbSeam) return _dbSeam
  return new SqliteAppTokenDb(getNoaDb())
}

// ---------------------------------------------------------------------------
// Secret seam
// ---------------------------------------------------------------------------

let _secretSeam: Buffer | null = null
export function __setSecretSeam(s: Buffer | null): void { _secretSeam = s }

function loadOrCreateSecret(): Buffer {
  if (_secretSeam) return _secretSeam
  const fromEnv = readEnvValue('APP_TOKEN_SECRET')
  if (fromEnv) return Buffer.from(fromEnv, 'utf-8')
  const secretPath = join(PROJECT_ROOT, 'store', '.app-token-secret')
  try {
    return Buffer.from(readFileSync(secretPath, 'utf-8').trim(), 'hex')
  } catch {
    const secret = randomBytes(32)
    mkdirSync(join(PROJECT_ROOT, 'store'), { recursive: true })
    writeFileSync(secretPath, secret.toString('hex'), { mode: 0o600 })
    logger.info('Generated new APP_TOKEN_SECRET at store/.app-token-secret')
    return secret
  }
}

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

export function applyAppTokenMigrations(db: Database.Database = getNoaDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_tokens (
      jti        TEXT PRIMARY KEY,
      issued_at  INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      label      TEXT
    )
  `)
}

// ---------------------------------------------------------------------------
// JWT helpers (HS256, Node.js crypto only)
// ---------------------------------------------------------------------------

function b64url(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf) : buf
  return b.toString('base64url')
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url')
}

export interface SignResult {
  token: string
  jti: string
  expiresAt: number
}

// ttlSeconds is injectable for tests (pass a negative value to produce an
// already-expired token for expiry-rejection tests).
export function signAppToken(secret: Buffer, ttlSeconds: number = APP_TOKEN_TTL_SECONDS): SignResult {
  const jti = randomBytes(16).toString('hex')
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + ttlSeconds
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ sub: 'app', iat, exp, jti }))
  const message = `${header}.${payload}`
  const sig = b64url(createHmac('sha256', secret).update(message).digest())
  return { token: `${message}.${sig}`, jti, expiresAt: exp }
}

export function verifyAppToken(
  token: string,
  secret: Buffer,
  db: AppTokenDb,
): AgentIdentity | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  const [headerB64, payloadB64, sigB64] = parts
  const message = `${headerB64}.${payloadB64}`

  // Constant-time signature check
  const expected = createHmac('sha256', secret).update(message).digest()
  let provided: Buffer
  try {
    provided = b64urlDecode(sigB64)
  } catch {
    return null
  }
  if (provided.length !== expected.length) return null
  if (!timingSafeEqual(provided, expected)) return null

  // Decode payload
  let payload: { sub?: string; iat?: number; exp?: number; jti?: string }
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString())
  } catch {
    return null
  }

  // Expiry check
  const nowSec = Math.floor(Date.now() / 1000)
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) return null

  // jti must be known and not revoked
  if (!payload.jti) return null
  if (!db.isKnown(payload.jti)) return null
  if (db.isRevoked(payload.jti)) return null

  return { agentId: 'app', scopes: [ADMIN_SCOPE], source: 'operator' }
}

// Convenience wrapper for use in web.ts auth gate: loads secret + DB internally.
export function verifyAppTokenBearer(bearer: string | null | undefined): AgentIdentity | null {
  if (!bearer) return null
  try {
    const secret = loadOrCreateSecret()
    return verifyAppToken(bearer, secret, getDb())
  } catch (err) {
    logger.warn({ err }, 'app-token verification error')
    return null
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function tryHandleAppAuth(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, identity } = ctx

  if (!path.startsWith('/api/auth/app-token')) return false

  // POST /api/auth/app-token/revoke
  if (path === '/api/auth/app-token/revoke' && method === 'POST') {
    if (!hasScope(identity?.scopes, ADMIN_SCOPE)) {
      json(res, { error: 'admin scope required' }, 403)
      return true
    }
    const raw = await readBody(req, { maxBytes: 4 * 1024 })
    let parsed: { jti?: unknown }
    try {
      parsed = JSON.parse(raw.toString())
    } catch {
      json(res, { error: 'invalid JSON' }, 400)
      return true
    }
    if (!parsed.jti || typeof parsed.jti !== 'string') {
      json(res, { error: 'jti is required' }, 400)
      return true
    }
    const db = getDb()
    if (!db.isKnown(parsed.jti)) {
      json(res, { error: 'token not found' }, 404)
      return true
    }
    db.revokeToken(parsed.jti, Math.floor(Date.now() / 1000))
    logger.info({ jti: parsed.jti, revokedBy: identity.agentId }, 'app-token revoked')
    json(res, { ok: true })
    return true
  }

  // POST /api/auth/app-token
  if (path === '/api/auth/app-token' && method === 'POST') {
    if (!hasScope(identity?.scopes, ADMIN_SCOPE)) {
      json(res, { error: 'admin scope required' }, 403)
      return true
    }
    const raw = await readBody(req, { maxBytes: 4 * 1024 })
    let parsed: { label?: unknown } = {}
    try {
      if (raw.length > 0) parsed = JSON.parse(raw.toString())
    } catch {
      json(res, { error: 'invalid JSON' }, 400)
      return true
    }
    const label = typeof parsed.label === 'string' ? parsed.label.slice(0, 128) : null
    const secret = loadOrCreateSecret()
    const { token, jti, expiresAt } = signAppToken(secret)
    getDb().insertToken(jti, Math.floor(Date.now() / 1000), expiresAt, label)
    logger.info({ jti, label, issuedBy: identity.agentId }, 'app-token issued')
    json(res, { ok: true, token, jti, expires_at: expiresAt }, 201)
    return true
  }

  return false
}
