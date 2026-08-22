import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const TEST_DIR = '/tmp/test-dashboard-session'

// Redirect PROJECT_ROOT so the session secret + token are written under /tmp,
// never the real store/.
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, PROJECT_ROOT: '/tmp/test-dashboard-session' }
})

import {
  createSession,
  verifySession,
  revokeSession,
  parseCookies,
  __resetSessionStateForTests,
  SESSION_MAX_AGE_SECONDS,
} from '../web/dashboard-auth.js'

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(join(TEST_DIR, 'store'), { recursive: true })
  __resetSessionStateForTests()
})

describe('session mint/verify', () => {
  it('mints an opaque value that verifies valid', () => {
    const v = createSession()
    expect(typeof v).toBe('string')
    expect(v).not.toContain('.') // base64url, no raw dots
    const r = verifySession(v)
    expect(r.valid).toBe(true)
    expect(r.expired).toBe(false)
    expect(r.sid).toBeTruthy()
  })

  it('rejects a tampered signature', () => {
    const v = createSession()
    // Flip the last char to corrupt the signature.
    const tampered = v.slice(0, -1) + (v.slice(-1) === 'A' ? 'B' : 'A')
    const r = verifySession(tampered)
    expect(r.valid).toBe(false)
  })

  it('rejects garbage / empty input', () => {
    expect(verifySession(undefined).valid).toBe(false)
    expect(verifySession('').valid).toBe(false)
    expect(verifySession('not-base64-$$$').valid).toBe(false)
    expect(verifySession(Buffer.from('a.b.c').toString('base64url')).valid).toBe(false)
  })

  it('keeps a validly-signed, unexpired cookie valid across a restart (stateless)', () => {
    const v = createSession()
    // Model a server restart: the in-memory session state is dropped, but the
    // persistent signing secret + the cookie are unchanged. The fix makes
    // validation stateless, so the session survives (no more constant re-login).
    __resetSessionStateForTests()
    expect(verifySession(v).valid).toBe(true)
  })
})

describe('expiry', () => {
  it('reports expired=true once the absolute expiry passes', () => {
    const t0 = 1_000_000_000_000
    const v = createSession(t0)
    expect(verifySession(v, t0).valid).toBe(true)
    const afterExpiry = t0 + (SESSION_MAX_AGE_SECONDS + 1) * 1000
    const r = verifySession(v, afterExpiry)
    expect(r.valid).toBe(false)
    expect(r.expired).toBe(true)
  })

  it('is still valid one second before expiry', () => {
    const t0 = 1_000_000_000_000
    const v = createSession(t0)
    const justBefore = t0 + (SESSION_MAX_AGE_SECONDS - 1) * 1000
    expect(verifySession(v, justBefore).valid).toBe(true)
  })
})

describe('revocation', () => {
  it('invalidates a session after revokeSession (logout)', () => {
    const v = createSession()
    expect(verifySession(v).valid).toBe(true)
    revokeSession(v)
    expect(verifySession(v).valid).toBe(false)
  })

  it('revokeSession is idempotent and tolerant of junk', () => {
    expect(() => revokeSession(undefined)).not.toThrow()
    expect(() => revokeSession('$$$')).not.toThrow()
    const v = createSession()
    revokeSession(v)
    revokeSession(v)
    expect(verifySession(v).valid).toBe(false)
  })

  it('revoking one session does not affect another', () => {
    const a = createSession()
    const b = createSession()
    revokeSession(a)
    expect(verifySession(a).valid).toBe(false)
    expect(verifySession(b).valid).toBe(true)
  })

  it('keeps a revoked session revoked across a restart (persisted)', () => {
    const v = createSession()
    revokeSession(v)
    // Model a restart: the revocation list reloads from disk, so logout sticks.
    __resetSessionStateForTests()
    expect(verifySession(v).valid).toBe(false)
  })
})

describe('parseCookies', () => {
  it('parses a multi-cookie header', () => {
    const c = parseCookies('gd_session=abc; theme=dark; foo=bar')
    expect(c.gd_session).toBe('abc')
    expect(c.theme).toBe('dark')
    expect(c.foo).toBe('bar')
  })

  it('handles whitespace, quotes and url-encoding', () => {
    const c = parseCookies('  gd_session = "a%20b" ;x=1')
    expect(c.gd_session).toBe('a b')
    expect(c.x).toBe('1')
  })

  it('returns empty for missing/empty header', () => {
    expect(parseCookies(undefined)).toEqual({})
    expect(parseCookies('')).toEqual({})
    expect(parseCookies('=novalue')).toEqual({})
  })
})
