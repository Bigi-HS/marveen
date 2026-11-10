// Showcase backend (card ee1f77e3, Phase 3A) + SEC-114 fixes.
//
// GET  /api/showcase/agents  -- anonymised agent list (roleLabel + state only)
// POST /api/showcase/token   -- mint a 24h share-JWT (admin scope required)
//
// Security contract:
//  - Zero internal data leaves: no agentId, no pane-tail, no card content,
//    no memory, no internal URLs, no token material in the response body.
//  - Only admin:* can mint share tokens; showcase-read-only cannot escalate.
//  - Per-bearer-token rate-limit on GET (SEC-114 fix #1): keyed on a SHA-256
//    prefix of the Authorization header, NOT on the socket IP. When running
//    behind a Funnel/reverse-proxy, all requests arrive from 127.0.0.1, so
//    an IP-keyed limiter collapses into one shared bucket for all visitors.
//    Bearer-keyed limits give every token its own bucket regardless of topology.
//  - Scope isolation enforced in web.ts (SEC-114 fix #2): showcase-read-only
//    identity is path-restricted to /api/showcase/* before reaching any route.
//  - Funnel exposure remains INERT until Boss-GO (Phase 3B wiring).

import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { json, readBody } from '../http-helpers.js'
import { hasScope, ADMIN_SCOPE, type AgentIdentity } from '../agent-token-registry.js'
import { logger } from '../../logger.js'
import { getNoaDb } from '../../noa-db.js'
import { PROJECT_ROOT } from '../../config.js'
import { readEnvValue } from '../../env.js'
import { createRateLimiter, type RateLimiter } from '../rate-limit.js'
import {
  listAgentNames,
  readAgentDisplayName,
} from '../agent-config.js'
import {
  isAgentRunning,
  capturePane,
  agentSessionName,
} from '../agent-process.js'
import {
  computeAgentActivityLabel,
  type AgentActivityLabel,
} from '../../pane-state.js'
import type { RouteContext } from './types.js'

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const SHOWCASE_SCOPE = 'showcase-read-only'

const SHOWCASE_TOKEN_TTL_SECONDS = 24 * 3600

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

export type ShowcaseState = 'running' | 'idle' | 'working' | 'stopped'

export interface ShowcaseAgent {
  roleLabel: string
  state: ShowcaseState
}

function mapState(label: AgentActivityLabel): ShowcaseState {
  switch (label) {
    case 'idle':    return 'idle'
    case 'working': return 'working'
    case 'stopped': return 'stopped'
    case 'unknown': return 'running'  // alive but pane unreadable
    case 'error':   return 'stopped'
  }
}

// ---------------------------------------------------------------------------
// DB interface + seam
// ---------------------------------------------------------------------------

export interface ShowcaseTokenDb {
  insertToken(jti: string, issuedAt: number, expiresAt: number): void
  isRevoked(jti: string): boolean
  isKnown(jti: string): boolean
}

let _dbSeam: ShowcaseTokenDb | null = null
export function __setDbSeam(db: ShowcaseTokenDb | null): void { _dbSeam = db }

class SqliteShowcaseTokenDb implements ShowcaseTokenDb {
  constructor(private db: Database.Database) {}

  insertToken(jti: string, issuedAt: number, expiresAt: number): void {
    this.db.prepare(
      'INSERT INTO showcase_tokens (jti, issued_at, expires_at) VALUES (?, ?, ?)',
    ).run(jti, issuedAt, expiresAt)
  }

  isRevoked(jti: string): boolean {
    const row = this.db.prepare(
      'SELECT revoked_at FROM showcase_tokens WHERE jti = ?',
    ).get(jti) as { revoked_at: number | null } | undefined
    return row ? row.revoked_at !== null : true
  }

  isKnown(jti: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM showcase_tokens WHERE jti = ?').get(jti)
  }
}

function getDb(): ShowcaseTokenDb {
  if (_dbSeam) return _dbSeam
  return new SqliteShowcaseTokenDb(getNoaDb())
}

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

export function applyShowcaseMigrations(db: Database.Database = getNoaDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS showcase_tokens (
      jti        TEXT PRIMARY KEY,
      issued_at  INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    )
  `)
}

// ---------------------------------------------------------------------------
// Secret seam
// ---------------------------------------------------------------------------

let _secretSeam: Buffer | null = null
export function __setSecretSeam(s: Buffer | null): void { _secretSeam = s }

function loadOrCreateSecret(): Buffer {
  if (_secretSeam) return _secretSeam
  const fromEnv = readEnvValue('SHOWCASE_TOKEN_SECRET')
  if (fromEnv) return Buffer.from(fromEnv, 'utf-8')
  const secretPath = join(PROJECT_ROOT, 'store', '.showcase-token-secret')
  try {
    return Buffer.from(readFileSync(secretPath, 'utf-8').trim(), 'hex')
  } catch {
    const secret = randomBytes(32)
    mkdirSync(join(PROJECT_ROOT, 'store'), { recursive: true })
    writeFileSync(secretPath, secret.toString('hex'), { mode: 0o600 })
    logger.info('Generated new SHOWCASE_TOKEN_SECRET at store/.showcase-token-secret')
    return secret
  }
}

// ---------------------------------------------------------------------------
// JWT helpers (HS256, same approach as app-auth.ts)
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

export function signShowcaseToken(
  secret: Buffer,
  ttlSeconds: number = SHOWCASE_TOKEN_TTL_SECONDS,
): SignResult {
  const jti = randomBytes(16).toString('hex')
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + ttlSeconds
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ sub: 'showcase', iat, exp, jti, scope: SHOWCASE_SCOPE }))
  const message = `${header}.${payload}`
  const sig = b64url(createHmac('sha256', secret).update(message).digest())
  return { token: `${message}.${sig}`, jti, expiresAt: exp }
}

export function verifyShowcaseJwt(
  token: string,
  secret: Buffer,
  db: ShowcaseTokenDb,
): AgentIdentity | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  const [headerB64, payloadB64, sigB64] = parts
  const message = `${headerB64}.${payloadB64}`

  const expected = createHmac('sha256', secret).update(message).digest()
  let provided: Buffer
  try {
    provided = b64urlDecode(sigB64)
  } catch {
    return null
  }
  if (provided.length !== expected.length) return null
  if (!timingSafeEqual(provided, expected)) return null

  let payload: { sub?: string; exp?: number; jti?: string; scope?: string }
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString())
  } catch {
    return null
  }

  if (payload.sub !== 'showcase') return null
  if (payload.scope !== SHOWCASE_SCOPE) return null

  const nowSec = Math.floor(Date.now() / 1000)
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) return null

  if (!payload.jti) return null
  if (!db.isKnown(payload.jti)) return null
  if (db.isRevoked(payload.jti)) return null

  return { agentId: 'showcase', scopes: [SHOWCASE_SCOPE], source: 'agent' }
}

export function verifyShowcaseJwtBearer(bearer: string | null | undefined): AgentIdentity | null {
  if (!bearer) return null
  const m = /^Bearer\s+(.+)$/.exec(bearer)
  if (!m) return null
  try {
    const secret = loadOrCreateSecret()
    return verifyShowcaseJwt(m[1].trim(), secret, getDb())
  } catch (err) {
    logger.warn({ err }, 'showcase-token verification error')
    return null
  }
}

// ---------------------------------------------------------------------------
// Scope isolation helper (SEC-114 fix #2)
// ---------------------------------------------------------------------------

// Pure predicate: is this path reachable with a showcase-read-only identity?
// Called by web.ts at the gate level (before routing) to enforce that a share
// JWT cannot access any path outside /api/showcase/*. Extracted as a named
// function so the gate logic is unit-testable in isolation.
export function isShowcaseAllowedPath(path: string): boolean {
  return path.startsWith('/api/showcase/')
}

// ---------------------------------------------------------------------------
// Agent list seam (injectable for tests)
// ---------------------------------------------------------------------------

let _agentListSeam: ShowcaseAgent[] | null = null
export function __setAgentListSeam(agents: ShowcaseAgent[] | null): void { _agentListSeam = agents }

function buildAgentList(): ShowcaseAgent[] {
  if (_agentListSeam !== null) return _agentListSeam
  try {
    const names = listAgentNames()
    return names.map((name) => {
      const displayName = readAgentDisplayName(name) || name.charAt(0).toUpperCase() + name.slice(1)
      const running = isAgentRunning(name)
      const pane = running ? capturePane(agentSessionName(name)) : null
      const label = computeAgentActivityLabel(running, pane)
      return { roleLabel: displayName, state: mapState(label) }
    })
  } catch (err) {
    logger.warn({ err }, 'showcase: failed to build agent list')
    return []
  }
}

// ---------------------------------------------------------------------------
// Rate limiter (injectable for tests)
// ---------------------------------------------------------------------------

let _rateLimiterSeam: RateLimiter | null = null
export function __setRateLimiterSeam(rl: RateLimiter | null): void { _rateLimiterSeam = rl }

// 20 req/min steady-state, burst of 20. Conservative for a public endpoint.
const _defaultRl = createRateLimiter({ capacity: 20, refillPerSec: 20 / 60 })

function getRateLimiter(): RateLimiter {
  return _rateLimiterSeam ?? _defaultRl
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function tryHandleShowcase(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, identity } = ctx

  if (!path.startsWith('/api/showcase/')) return false

  // GET /api/showcase/agents
  if (path === '/api/showcase/agents' && method === 'GET') {
    // Rate-limit key: SHA-256 prefix of the Authorization header (per-bearer-
    // token bucket). Behind a reverse-proxy/Funnel, all requests share the same
    // socket IP (127.0.0.1), so an IP-keyed bucket would collapse the whole
    // allowance into one shared pool. Keying on the bearer guarantees each token
    // gets its own 20-req/min budget regardless of network topology. We hash to
    // avoid storing the raw credential in the in-memory bucket map.
    const authHeader = (req.headers as Record<string, string | undefined>)['authorization'] ?? ''
    const rlKey = authHeader
      ? createHash('sha256').update(authHeader).digest('hex').slice(0, 16)
      : (req.socket as { remoteAddress?: string })?.remoteAddress ?? 'unknown'
    const rl = getRateLimiter()
    const rlResult = rl.allow(rlKey)
    if (!rlResult.allowed) {
      json(res, { error: 'rate limit exceeded' }, 429)
      return true
    }

    // Auth: admin OR showcase-read-only scope required.
    const hasAuth = hasScope(identity?.scopes, ADMIN_SCOPE) || hasScope(identity?.scopes, SHOWCASE_SCOPE)
    if (!hasAuth) {
      json(res, { error: 'Unauthorized' }, 401)
      return true
    }

    const agents = buildAgentList()
    json(res, { agents })
    return true
  }

  // POST /api/showcase/token
  if (path === '/api/showcase/token' && method === 'POST') {
    if (!hasScope(identity?.scopes, ADMIN_SCOPE)) {
      json(res, { error: 'admin scope required' }, 403)
      return true
    }

    // body is optional (may carry a label in future; ignored for now)
    await readBody(req, { maxBytes: 4 * 1024 }).catch(() => null)

    const secret = loadOrCreateSecret()
    const { token, jti, expiresAt } = signShowcaseToken(secret)
    getDb().insertToken(jti, Math.floor(Date.now() / 1000), expiresAt)
    logger.info({ jti, issuedBy: identity.agentId }, 'showcase-token issued')
    json(res, { ok: true, token, jti, expires_at: expiresAt }, 201)
    return true
  }

  return false
}
