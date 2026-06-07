import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, timingSafeEqual, createHmac } from 'node:crypto'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'

// A single bearer token gates every /api/* route. It is loaded from
// DASHBOARD_TOKEN if set, otherwise persisted at store/.dashboard-token
// (mode 0600) and auto-generated on first run. Static assets (/, /index.html,
// /style.css, /app.js, /avatars/*) and the auth-status endpoint stay public
// so the UI can bootstrap itself.
const DASHBOARD_TOKEN_PATH = join(PROJECT_ROOT, 'store', '.dashboard-token')

// Server-side signing secret for HttpOnly session cookies. Persisted at
// store/.dashboard-session-secret (mode 0600), auto-generated on first use
// just like the bearer token. Distinct from the bearer token so rotating the
// access token does NOT invalidate live sessions and vice versa.
const SESSION_SECRET_PATH = join(PROJECT_ROOT, 'store', '.dashboard-session-secret')

// Session lifetime. The signed cookie carries an absolute expiry; after this
// the operator re-enters the access token once. 12h keeps a workday logged in.
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60

export function loadOrCreateDashboardToken(): string {
  const fromEnv = process.env.DASHBOARD_TOKEN?.trim()
  if (fromEnv) return fromEnv
  try {
    if (existsSync(DASHBOARD_TOKEN_PATH)) {
      const cached = readFileSync(DASHBOARD_TOKEN_PATH, 'utf-8').trim()
      if (cached) return cached
    }
  } catch { /* fall through and regenerate */ }
  const fresh = randomBytes(32).toString('hex')
  mkdirSync(join(PROJECT_ROOT, 'store'), { recursive: true })
  atomicWriteFileSync(DASHBOARD_TOKEN_PATH, fresh, { mode: 0o600 })
  return fresh
}

// In-memory copy of the active bearer token the auth middleware checks. Kept
// here (not as a closure const in web.ts) so the token can be rotated at
// runtime via the admin API without a server restart: rotateDashboardToken()
// persists a fresh token to disk AND updates this value, so the auth gate
// honours the new token immediately and the old one stops working.
let activeDashboardToken: string | null = null

// Seed the in-memory token on startup. web.ts calls this once with the value
// loadOrCreateDashboardToken() returned, so getDashboardToken() and the file
// stay in sync from the first request.
export function initDashboardToken(token: string): void {
  activeDashboardToken = token
}

// Current active bearer token. Falls back to loadOrCreateDashboardToken() if
// init was never called (e.g. a unit test importing the rotate route in
// isolation), so the auth check always has a value to compare against.
export function getDashboardToken(): string {
  if (activeDashboardToken === null) {
    activeDashboardToken = loadOrCreateDashboardToken()
  }
  return activeDashboardToken
}

// Generate a fresh bearer token, persist it to store/.dashboard-token
// (atomic, mode 0600) and swap the in-memory value so the new token is valid
// immediately and the previous one is rejected -- no restart required.
// Returns the new token so the caller can surface it once to the operator.
export function rotateDashboardToken(): string {
  const fresh = randomBytes(32).toString('hex')
  mkdirSync(join(PROJECT_ROOT, 'store'), { recursive: true })
  atomicWriteFileSync(DASHBOARD_TOKEN_PATH, fresh, { mode: 0o600 })
  activeDashboardToken = fresh
  return fresh
}

export function checkBearerToken(header: string | undefined, expected: string): boolean {
  if (!header) return false
  const m = /^Bearer\s+(.+)$/.exec(header)
  if (!m) return false
  const provided = Buffer.from(m[1].trim())
  const wanted = Buffer.from(expected)
  if (provided.length !== wanted.length) return false
  return timingSafeEqual(provided, wanted)
}

// Operator-facing access instructions printed on startup. SECURITY: the URL must
// NOT carry the token. A URL with ?token=<root-equivalent-credential> leaks into
// shell history, server/proxy access logs, the browser address bar and referrers.
// We print a tokenless URL and the token on its OWN line; the UI prompts for it
// and stores it client-side (the dashboard still strips a legacy ?token= too).
export function buildDashboardAccessMessage(port: number, token: string): string {
  return [
    '',
    'Dashboard access:',
    `  1. Open in your browser:  http://127.0.0.1:${port}/`,
    '  2. When prompted, paste this access token:',
    `     ${token}`,
    '',
    '',
  ].join('\n')
}

// === Session cookie layer ===
// A signed, opaque session value gates the browser UI without the raw access
// token ever living in localStorage. The value is base64url("<payload>.<sig>")
// where payload = "<sid>.<issuedAt>.<expiry>" (seconds) and sig =
// HMAC-SHA256(secret, payload). Verification is offline (no DB) but revocation
// is supported via an in-memory issued/revoked set, so logout takes effect
// immediately for the running process. The sets are intentionally in-memory:
// a server restart re-issues, and the expiry caps the blast radius regardless.

let sessionSecret: Buffer | null = null
// Sids we have minted this process lifetime. A cookie whose sid is unknown
// (e.g. signed by a previous secret, or forged) is treated as invalid even if
// the signature somehow matched. Cleared sids (logout/expiry sweep) drop out.
const issuedSids = new Set<string>()
const revokedSids = new Set<string>()

function loadOrCreateSessionSecret(): Buffer {
  if (sessionSecret) return sessionSecret
  try {
    if (existsSync(SESSION_SECRET_PATH)) {
      const hex = readFileSync(SESSION_SECRET_PATH, 'utf-8').trim()
      if (hex) {
        sessionSecret = Buffer.from(hex, 'hex')
        return sessionSecret
      }
    }
  } catch { /* fall through and regenerate */ }
  const fresh = randomBytes(32)
  mkdirSync(join(PROJECT_ROOT, 'store'), { recursive: true })
  atomicWriteFileSync(SESSION_SECRET_PATH, fresh.toString('hex'), { mode: 0o600 })
  sessionSecret = fresh
  return fresh
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function sign(payload: string): string {
  return b64url(createHmac('sha256', loadOrCreateSessionSecret()).update(payload).digest())
}

// Mint a fresh signed session value and register its sid as issued. Returns the
// opaque cookie value (no secrets recoverable from it).
export function createSession(nowMs: number = Date.now()): string {
  const sid = randomBytes(18).toString('hex')
  const issuedAt = Math.floor(nowMs / 1000)
  const expiry = issuedAt + SESSION_MAX_AGE_SECONDS
  const payload = `${sid}.${issuedAt}.${expiry}`
  issuedSids.add(sid)
  revokedSids.delete(sid)
  return b64url(Buffer.from(`${payload}.${sign(payload)}`))
}

export interface SessionVerification {
  valid: boolean
  // True when the signature/sid were fine but the absolute expiry has passed.
  // Lets the caller distinguish "log in again" from "tampered/unknown".
  expired: boolean
  sid?: string
}

// Verify a session cookie value: signature, known+unrevoked sid, and expiry.
// Pure aside from reading the in-memory sid sets; safe to unit-test directly.
export function verifySession(value: string | undefined, nowMs: number = Date.now()): SessionVerification {
  if (!value) return { valid: false, expired: false }
  let decoded: string
  try {
    const b64 = value.replace(/-/g, '+').replace(/_/g, '/')
    decoded = Buffer.from(b64, 'base64').toString('utf-8')
  } catch {
    return { valid: false, expired: false }
  }
  const parts = decoded.split('.')
  if (parts.length !== 4) return { valid: false, expired: false }
  const [sid, issuedAt, expiry, sig] = parts
  const payload = `${sid}.${issuedAt}.${expiry}`
  const expected = sign(payload)
  // Constant-time signature comparison.
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false, expired: false }
  if (!issuedSids.has(sid) || revokedSids.has(sid)) return { valid: false, expired: false }
  const exp = Number(expiry)
  if (!Number.isFinite(exp)) return { valid: false, expired: false }
  if (Math.floor(nowMs / 1000) >= exp) return { valid: false, expired: true, sid }
  return { valid: true, expired: false, sid }
}

// Revoke a single session (logout). Idempotent.
export function revokeSession(value: string | undefined): void {
  if (!value) return
  let decoded: string
  try {
    const b64 = value.replace(/-/g, '+').replace(/_/g, '/')
    decoded = Buffer.from(b64, 'base64').toString('utf-8')
  } catch { return }
  const sid = decoded.split('.')[0]
  if (sid) {
    revokedSids.add(sid)
    issuedSids.delete(sid)
  }
}

// Parse a Cookie header into a name->value map. No external dependency; values
// are URL-decoded best-effort. Tolerant of stray whitespace and bare names.
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const name = pair.slice(0, eq).trim()
    if (!name) continue
    let val = pair.slice(eq + 1).trim()
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1)
    try { val = decodeURIComponent(val) } catch { /* keep raw */ }
    out[name] = val
  }
  return out
}

export const SESSION_COOKIE_NAME = 'gd_session'

// Test-only: reset the in-memory session state so unit tests don't leak sids
// across cases. Not used in production code paths.
export function __resetSessionStateForTests(): void {
  issuedSids.clear()
  revokedSids.clear()
}
