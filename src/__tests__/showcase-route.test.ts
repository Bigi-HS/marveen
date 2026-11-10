// Tests for GET /api/showcase/agents + POST /api/showcase/token
// TDD: written before implementation (card ee1f77e3, Phase 3A).
//
// Security invariants (Chad STRIDE targets):
//  S1 - no raw agentId in response
//  S2 - no pane tail / internal URL / card content in response
//  S3 - POST /api/showcase/token requires admin scope; showcase-read-only cannot mint
//  S4 - expired showcase JWT is rejected
//  S5 - IP rate-limit fires on GET when burst exceeded
//  S6 - anonymous (no token) GET is 401

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import Database from 'better-sqlite3'
import {
  tryHandleShowcase,
  applyShowcaseMigrations,
  signShowcaseToken,
  verifyShowcaseJwt,
  verifyShowcaseJwtBearer,
  isShowcaseAllowedPath,
  __setSecretSeam,
  __setDbSeam,
  __setAgentListSeam,
  __setRateLimiterSeam,
  SHOWCASE_SCOPE,
  type ShowcaseAgent,
  type ShowcaseTokenDb,
} from '../web/routes/showcase.js'
import { type AgentIdentity, ADMIN_SCOPE } from '../web/agent-token-registry.js'
import { type RateLimiter } from '../web/rate-limit.js'

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

const ADMIN: AgentIdentity = { agentId: 'marveen', scopes: [ADMIN_SCOPE], source: 'operator' }
const SHOWCASE_READER: AgentIdentity = { agentId: 'showcase', scopes: [SHOWCASE_SCOPE], source: 'agent' }
const AGENT_NO_SCOPE: AgentIdentity = { agentId: 'dave', scopes: [], source: 'agent' }
const ANON: AgentIdentity = { agentId: '', scopes: [], source: 'agent' }

const TEST_SECRET = Buffer.from('showcase-test-32-bytes-padded-aa')

// ---------------------------------------------------------------------------
// Test DB
// ---------------------------------------------------------------------------

function makeDb(): ShowcaseTokenDb & { _db: Database.Database } {
  const db = new Database(':memory:')
  applyShowcaseMigrations(db)
  return {
    _db: db,
    insertToken(jti, issuedAt, expiresAt) {
      db.prepare('INSERT INTO showcase_tokens (jti, issued_at, expires_at) VALUES (?, ?, ?)')
        .run(jti, issuedAt, expiresAt)
    },
    isRevoked(jti) {
      const row = db.prepare('SELECT revoked_at FROM showcase_tokens WHERE jti = ?').get(jti) as { revoked_at: number | null } | undefined
      return row ? row.revoked_at !== null : true
    },
    isKnown(jti) {
      return !!db.prepare('SELECT 1 FROM showcase_tokens WHERE jti = ?').get(jti)
    },
  }
}

// ---------------------------------------------------------------------------
// Test agent list seam
// ---------------------------------------------------------------------------

const SAMPLE_AGENTS: ShowcaseAgent[] = [
  { roleLabel: 'NoA', state: 'idle' },
  { roleLabel: 'Dave', state: 'working' },
  { roleLabel: 'Grace', state: 'stopped' },
]

// ---------------------------------------------------------------------------
// Rate-limiter seam
// ---------------------------------------------------------------------------

function makePermissiveRl(): RateLimiter {
  return {
    allow: (_key) => ({ allowed: true, retryAfterMs: 0 }),
    prune: () => 0,
    size: () => 0,
  }
}

function makeBlockingRl(): RateLimiter {
  return {
    allow: (_key) => ({ allowed: false, retryAfterMs: 1000 }),
    prune: () => 0,
    size: () => 0,
  }
}

// ---------------------------------------------------------------------------
// HTTP call helper
// ---------------------------------------------------------------------------

async function call(
  method: string,
  path: string,
  identity: AgentIdentity = ANON,
  remoteAddress?: string,
  authorizationHeader?: string,
) {
  const url = new URL('http://x' + path)
  const req = Object.assign(Readable.from([]), {
    socket: { remoteAddress: remoteAddress ?? '127.0.0.1' },
    headers: authorizationHeader ? { authorization: authorizationHeader } : {},
  }) as never
  const captured: { status: number; headers: Record<string, string>; body: unknown } = {
    status: 200,
    headers: {},
    body: undefined,
  }
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status
      if (headers) Object.assign(captured.headers, headers)
      return res
    },
    setHeader(k: string, v: string) { captured.headers[k] = v },
    end(b?: string) { captured.body = b ? JSON.parse(b) : undefined },
  } as never

  const handled = await tryHandleShowcase({ req, res, method, path: url.pathname, url, identity } as never)
  return { handled, ...captured }
}

afterEach(() => {
  __setSecretSeam(null)
  __setDbSeam(null)
  __setAgentListSeam(null)
  __setRateLimiterSeam(null)
})

beforeEach(() => {
  __setSecretSeam(TEST_SECRET)
  __setDbSeam(makeDb())
  __setAgentListSeam(SAMPLE_AGENTS)
  __setRateLimiterSeam(makePermissiveRl())
})

// ---------------------------------------------------------------------------
// Route guard: unrelated paths pass through
// ---------------------------------------------------------------------------

describe('route guard', () => {
  it('passes through unrelated path', async () => {
    const r = await call('GET', '/api/agents')
    expect(r.handled).toBe(false)
  })

  it('passes through POST on agents', async () => {
    const r = await call('POST', '/api/showcase/agents')
    expect(r.handled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// GET /api/showcase/agents -- auth
// ---------------------------------------------------------------------------

describe('GET /api/showcase/agents -- auth', () => {
  it('[S6] 401 for anonymous caller (no scope)', async () => {
    const r = await call('GET', '/api/showcase/agents', ANON)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(401)
  })

  it('[S6] 401 for caller with unrelated scope', async () => {
    const r = await call('GET', '/api/showcase/agents', AGENT_NO_SCOPE)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(401)
  })

  it('allows admin identity', async () => {
    const r = await call('GET', '/api/showcase/agents', ADMIN)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
  })

  it('allows showcase-read-only identity', async () => {
    const r = await call('GET', '/api/showcase/agents', SHOWCASE_READER)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// GET /api/showcase/agents -- response shape (security DTO invariants)
// ---------------------------------------------------------------------------

describe('GET /api/showcase/agents -- response shape', () => {
  it('returns array of ShowcaseAgent', async () => {
    const r = await call('GET', '/api/showcase/agents', ADMIN)
    expect(r.status).toBe(200)
    const body = r.body as { agents: ShowcaseAgent[] }
    expect(Array.isArray(body.agents)).toBe(true)
  })

  it('[S1] response objects have only roleLabel and state fields', async () => {
    const r = await call('GET', '/api/showcase/agents', ADMIN)
    const body = r.body as { agents: ShowcaseAgent[] }
    for (const agent of body.agents) {
      const keys = Object.keys(agent)
      expect(keys.sort()).toEqual(['roleLabel', 'state'].sort())
    }
  })

  it('[S1] roleLabel is a non-empty string', async () => {
    const r = await call('GET', '/api/showcase/agents', ADMIN)
    const body = r.body as { agents: ShowcaseAgent[] }
    for (const agent of body.agents) {
      expect(typeof agent.roleLabel).toBe('string')
      expect(agent.roleLabel.length).toBeGreaterThan(0)
    }
  })

  it('state is one of the allowed enum values', async () => {
    const r = await call('GET', '/api/showcase/agents', ADMIN)
    const body = r.body as { agents: ShowcaseAgent[] }
    const valid = new Set(['running', 'idle', 'working', 'stopped'])
    for (const agent of body.agents) {
      expect(valid.has(agent.state)).toBe(true)
    }
  })

  it('returns expected sample agents', async () => {
    const r = await call('GET', '/api/showcase/agents', ADMIN)
    const body = r.body as { agents: ShowcaseAgent[] }
    expect(body.agents).toEqual(SAMPLE_AGENTS)
  })
})

// ---------------------------------------------------------------------------
// GET /api/showcase/agents -- IP rate-limit
// ---------------------------------------------------------------------------

describe('GET /api/showcase/agents -- rate-limit', () => {
  it('[S5] 429 when rate-limiter denies', async () => {
    __setRateLimiterSeam(makeBlockingRl())
    const r = await call('GET', '/api/showcase/agents', ADMIN, '1.2.3.4')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(429)
  })

  it('passes when rate-limiter allows', async () => {
    __setRateLimiterSeam(makePermissiveRl())
    const r = await call('GET', '/api/showcase/agents', ADMIN, '1.2.3.4')
    expect(r.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// POST /api/showcase/token -- auth gate
// ---------------------------------------------------------------------------

describe('POST /api/showcase/token -- auth', () => {
  it('[S3] 403 for anonymous caller', async () => {
    const r = await call('POST', '/api/showcase/token', ANON)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(403)
  })

  it('[S3] 403 for showcase-read-only caller (cannot self-escalate)', async () => {
    const r = await call('POST', '/api/showcase/token', SHOWCASE_READER)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(403)
  })

  it('[S3] 403 for agent without admin scope', async () => {
    const r = await call('POST', '/api/showcase/token', AGENT_NO_SCOPE)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(403)
  })

  it('201 for admin caller', async () => {
    const r = await call('POST', '/api/showcase/token', ADMIN)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(201)
  })
})

// ---------------------------------------------------------------------------
// POST /api/showcase/token -- response shape
// ---------------------------------------------------------------------------

describe('POST /api/showcase/token -- response', () => {
  it('returns token, jti, and expires_at', async () => {
    const r = await call('POST', '/api/showcase/token', ADMIN)
    const body = r.body as { ok: boolean; token: string; jti: string; expires_at: number }
    expect(body.ok).toBe(true)
    expect(typeof body.token).toBe('string')
    expect(typeof body.jti).toBe('string')
    expect(typeof body.expires_at).toBe('number')
  })

  it('token expires ~24h in the future', async () => {
    const before = Math.floor(Date.now() / 1000)
    const r = await call('POST', '/api/showcase/token', ADMIN)
    const body = r.body as { expires_at: number }
    const after = Math.floor(Date.now() / 1000)
    expect(body.expires_at).toBeGreaterThanOrEqual(before + 24 * 3600)
    expect(body.expires_at).toBeLessThanOrEqual(after + 24 * 3600 + 2)
  })
})

// ---------------------------------------------------------------------------
// JWT sign + verify
// ---------------------------------------------------------------------------

describe('signShowcaseToken / verifyShowcaseJwt', () => {
  it('roundtrip: signed token verifies successfully', () => {
    const db = makeDb()
    const { token, jti, expiresAt } = signShowcaseToken(TEST_SECRET)
    db.insertToken(jti, Math.floor(Date.now() / 1000), expiresAt)
    const result = verifyShowcaseJwt(token, TEST_SECRET, db)
    expect(result).not.toBeNull()
    expect(result?.scopes).toContain(SHOWCASE_SCOPE)
  })

  it('[S4] expired token is rejected', () => {
    const db = makeDb()
    const { token, jti } = signShowcaseToken(TEST_SECRET, -1)
    db.insertToken(jti, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) - 1)
    const result = verifyShowcaseJwt(token, TEST_SECRET, db)
    expect(result).toBeNull()
  })

  it('tampered signature is rejected', () => {
    const db = makeDb()
    const { token, jti, expiresAt } = signShowcaseToken(TEST_SECRET)
    db.insertToken(jti, Math.floor(Date.now() / 1000), expiresAt)
    const tampered = token.slice(0, -4) + 'XXXX'
    expect(verifyShowcaseJwt(tampered, TEST_SECRET, db)).toBeNull()
  })

  it('unknown jti is rejected', () => {
    const { token } = signShowcaseToken(TEST_SECRET)
    const db = makeDb()
    expect(verifyShowcaseJwt(token, TEST_SECRET, db)).toBeNull()
  })

  it('verifyShowcaseJwtBearer returns identity for valid token', () => {
    const db = makeDb()
    __setDbSeam(db)
    const { token, jti, expiresAt } = signShowcaseToken(TEST_SECRET)
    db.insertToken(jti, Math.floor(Date.now() / 1000), expiresAt)
    const identity = verifyShowcaseJwtBearer(`Bearer ${token}`)
    expect(identity).not.toBeNull()
    expect(identity?.scopes).toContain(SHOWCASE_SCOPE)
  })

  it('verifyShowcaseJwtBearer returns null for garbage', () => {
    expect(verifyShowcaseJwtBearer('Bearer garbage')).toBeNull()
    expect(verifyShowcaseJwtBearer(null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// SEC-114 fix #1: per-bearer rate-limit (Funnel-safe)
// ---------------------------------------------------------------------------

describe('SEC-114 fix #1 -- per-bearer rate-limit key', () => {
  it('two distinct auth headers get separate buckets (one blocked, one passes)', async () => {
    // First token exhausts its bucket.
    let blocked = false
    const rl1Calls: string[] = []
    __setRateLimiterSeam({
      allow: (key) => {
        rl1Calls.push(key)
        // Block the first unique key (simulating exhaustion), pass the second.
        const unique = [...new Set(rl1Calls)]
        return unique.length === 1 && rl1Calls.filter(k => k === key).length > 1
          ? { allowed: false, retryAfterMs: 1000 }
          : { allowed: true, retryAfterMs: 0 }
      },
      prune: () => 0,
      size: () => 0,
    })
    // First call with header A -- passes (first hit on key A)
    const r1 = await call('GET', '/api/showcase/agents', ADMIN, '127.0.0.1', 'Bearer tokenA')
    expect(r1.status).toBe(200)
    // Second call with same header A -- blocked (second hit on same key)
    const r2 = await call('GET', '/api/showcase/agents', ADMIN, '127.0.0.1', 'Bearer tokenA')
    expect(r2.status).toBe(429)
    // Call with different header B -- passes (first hit on key B)
    const r3 = await call('GET', '/api/showcase/agents', ADMIN, '127.0.0.1', 'Bearer tokenB')
    expect(r3.status).toBe(200)
    // The two distinct tokens must have produced distinct RL keys.
    const unique = [...new Set(rl1Calls)]
    expect(unique.length).toBe(2)
    blocked = r2.status === 429
    expect(blocked).toBe(true)
  })

  it('no-auth request falls back to socket IP key', async () => {
    const seenKeys: string[] = []
    __setRateLimiterSeam({
      allow: (key) => { seenKeys.push(key); return { allowed: true, retryAfterMs: 0 } },
      prune: () => 0,
      size: () => 0,
    })
    await call('GET', '/api/showcase/agents', ADMIN, '10.0.0.1')
    expect(seenKeys[0]).toBe('10.0.0.1')
  })

  it('rate-limit key is not the raw token (must be hashed)', async () => {
    const seenKeys: string[] = []
    __setRateLimiterSeam({
      allow: (key) => { seenKeys.push(key); return { allowed: true, retryAfterMs: 0 } },
      prune: () => 0,
      size: () => 0,
    })
    const rawToken = 'Bearer supersecrettoken123'
    await call('GET', '/api/showcase/agents', ADMIN, '127.0.0.1', rawToken)
    expect(seenKeys[0]).not.toContain('supersecrettoken123')
    expect(seenKeys[0]).toMatch(/^[0-9a-f]{16}$/)
  })
})

// ---------------------------------------------------------------------------
// SEC-114 fix #2: scope isolation (isShowcaseAllowedPath)
// ---------------------------------------------------------------------------

describe('SEC-114 fix #2 -- isShowcaseAllowedPath scope isolation', () => {
  it('allows /api/showcase/agents', () => {
    expect(isShowcaseAllowedPath('/api/showcase/agents')).toBe(true)
  })

  it('allows /api/showcase/token', () => {
    expect(isShowcaseAllowedPath('/api/showcase/token')).toBe(true)
  })

  it('allows any /api/showcase/* sub-path', () => {
    expect(isShowcaseAllowedPath('/api/showcase/anything/nested')).toBe(true)
  })

  it('[S2] blocks /api/journal -- private data endpoint', () => {
    expect(isShowcaseAllowedPath('/api/journal')).toBe(false)
  })

  it('[S2] blocks /api/workout -- private data endpoint', () => {
    expect(isShowcaseAllowedPath('/api/workout')).toBe(false)
  })

  it('[S2] blocks /api/push/settings -- private data endpoint', () => {
    expect(isShowcaseAllowedPath('/api/push/settings')).toBe(false)
  })

  it('[S2] blocks /api/memories -- private data endpoint', () => {
    expect(isShowcaseAllowedPath('/api/memories')).toBe(false)
  })

  it('[S2] blocks /api/agents -- internal agent config', () => {
    expect(isShowcaseAllowedPath('/api/agents')).toBe(false)
  })

  it('[S2] blocks /api/kanban -- internal task data', () => {
    expect(isShowcaseAllowedPath('/api/kanban')).toBe(false)
  })

  it('blocks a path that merely contains "showcase" mid-string', () => {
    // Guard against accidental path-prefix bypasses.
    expect(isShowcaseAllowedPath('/api/not-showcase/agents')).toBe(false)
  })
})
