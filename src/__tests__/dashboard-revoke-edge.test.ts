import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Regression tests for the two non-blocking flags Thor raised on PR#66
// (card edd3cae0): the persisted session-revocation list must (1) treat a
// corrupt/empty file as an EMPTY list without crashing, and (2) prune entries
// that are past expiry or carry a non-finite value when it loads. Both
// behaviours already hold in dashboard-auth.ts; these lock them in.

const TEST_DIR = '/tmp/test-dashboard-revoke-edge'

// NB: the path is inlined (not TEST_DIR) -- vi.mock is hoisted above the const,
// so referencing TEST_DIR here would read it before initialization.
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, PROJECT_ROOT: '/tmp/test-dashboard-revoke-edge' }
})

import {
  createSession,
  verifySession,
  revokeSession,
  __resetSessionStateForTests,
} from '../web/dashboard-auth.js'

// Mirrors the on-disk path in dashboard-auth.ts (PROJECT_ROOT/store/...).
const REVOKED_PATH = join(TEST_DIR, 'store', '.dashboard-revoked-sessions.json')

// Decode the sid out of an opaque session cookie value, which is the base64url
// encoding of "sid.issuedAt.expiry.sig". Lets a test mark a specific session
// revoked by writing the revocation file directly.
function sidOf(cookie: string): string {
  const b64 = cookie.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(b64, 'base64').toString('utf-8').split('.')[0]
}
const nowSec = () => Math.floor(Date.now() / 1000)

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(join(TEST_DIR, 'store'), { recursive: true })
  // Drop the in-memory cache so each case reloads from the file it just wrote
  // (models the server restart the persisted list is meant to survive).
  __resetSessionStateForTests()
})

describe('revocation list: corrupt/empty file => empty list (Thor PR#66 flag 1)', () => {
  it('treats a syntactically corrupt file as an empty list, without throwing', () => {
    writeFileSync(REVOKED_PATH, '{not valid json')
    __resetSessionStateForTests()
    const v = createSession()
    // The unreadable file must yield an EMPTY revocation map -- never a crash and
    // never a spuriously-revoked session. (Deliberately fail-open: a corrupt file
    // is an operational anomaly, sessions still expire at their own 12h bound, so
    // the worst case is a logged-out session lasting until that expiry.)
    expect(() => verifySession(v)).not.toThrow()
    expect(verifySession(v).valid).toBe(true)
  })

  it('treats an empty file as an empty list', () => {
    writeFileSync(REVOKED_PATH, '')
    __resetSessionStateForTests()
    const v = createSession()
    expect(verifySession(v).valid).toBe(true)
  })

  it('treats a non-object JSON body (e.g. a bare number) as an empty list', () => {
    writeFileSync(REVOKED_PATH, '42')
    __resetSessionStateForTests()
    const v = createSession()
    expect(() => verifySession(v)).not.toThrow()
    expect(verifySession(v).valid).toBe(true)
  })
})

describe('revocation list: prune stale/non-finite entries on load (Thor PR#66 flag 2)', () => {
  it('drops past-expiry and non-finite entries, keeps live ones', () => {
    const past = nowSec() - 10
    const future = nowSec() + 3600
    writeFileSync(REVOKED_PATH, JSON.stringify({
      'expired-sid': past,        // past its expiry -> pruned
      'nonfinite-sid': 'NaN',     // not a finite number -> pruned
      'null-sid': null,           // not a finite number -> pruned
      'live-sid': future,         // still in force -> retained
    }))
    __resetSessionStateForTests()
    // revokeSession() loads (and thus prunes) the list, then persists it, so the
    // on-disk file reflects the pruned map plus the new revocation.
    const v = createSession()
    revokeSession(v)
    const persisted = JSON.parse(readFileSync(REVOKED_PATH, 'utf-8')) as Record<string, unknown>
    expect(persisted['expired-sid']).toBeUndefined()
    expect(persisted['nonfinite-sid']).toBeUndefined()
    expect(persisted['null-sid']).toBeUndefined()
    expect(persisted['live-sid']).toBe(future)
    expect(persisted[sidOf(v)]).toBeDefined()
  })

  it('an expired revoke entry no longer blocks a still-valid cookie', () => {
    const v = createSession()
    writeFileSync(REVOKED_PATH, JSON.stringify({ [sidOf(v)]: nowSec() - 1 }))
    __resetSessionStateForTests()
    // The cookie itself is unexpired (12h); the stale revoke entry is pruned on
    // load, so the session verifies valid again.
    expect(verifySession(v).valid).toBe(true)
  })

  it('a live revoke entry still blocks its session across a reload (restart)', () => {
    const v = createSession()
    writeFileSync(REVOKED_PATH, JSON.stringify({ [sidOf(v)]: nowSec() + 3600 }))
    __resetSessionStateForTests()
    expect(verifySession(v).valid).toBe(false)
  })
})
