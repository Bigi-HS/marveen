import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, timingSafeEqual, createHmac, createHash, scryptSync } from 'node:crypto'
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
// the operator re-enters the access token once. This is a single-operator,
// localhost/tailnet-only dashboard, so a short 12h "workday" session just meant
// the operator (and every fleet-facing kanban tab) was re-prompted for the token
// daily. We default to ONE YEAR -- mirroring the 1-year OAuth setup-token policy:
// paste the token once, stay logged in for a year. Override via
// DASHBOARD_SESSION_MAX_AGE_SECONDS (positive integer seconds) if a shorter
// window is ever wanted. Per-session logout (revokeSession) still works
// instantly. NOTE: rotating the bearer token does NOT invalidate live sessions
// -- sessions are signed with the separate session secret (see above), not the
// bearer token. To mass-invalidate EVERY session at once (e.g. an incident),
// delete store/.dashboard-session-secret and restart: a fresh secret makes
// every existing cookie signature fail verification.
function resolveSessionMaxAge(): number {
  const ONE_YEAR = 365 * 24 * 60 * 60
  const raw = process.env.DASHBOARD_SESSION_MAX_AGE_SECONDS?.trim()
  if (raw) {
    const n = Number(raw)
    if (Number.isInteger(n) && n > 0) return n
  }
  return ONE_YEAR
}
export const SESSION_MAX_AGE_SECONDS = resolveSessionMaxAge()

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

// Pull the raw token out of an `Authorization: Bearer <token>` header, or
// undefined when the header is absent/malformed. Used by the per-agent identity
// resolver (agent-token-registry) which must hash the presented token rather
// than only compare it against the shared one.
export function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined
  const m = /^Bearer\s+(.+)$/.exec(header)
  return m ? m[1].trim() : undefined
}

export interface RequestOrigin {
  // true = arrived over the tailnet via the Tailscale Serve proxy; false = a
  // direct loopback hit on 127.0.0.1.
  remote: boolean
  // the real client IP where known (first X-Forwarded-For hop when remote, the
  // socket peer otherwise), or 'unknown'.
  sourceIp: string
}

// Classify where a request originated, for the remote/local audit tag (AC8 of
// the remote-access spec). The dashboard binds to 127.0.0.1, so the intended
// remote ingress is the Tailscale Serve proxy, which terminates TLS and adds an
// X-Forwarded-For header carrying the tailnet client IP. A request with a
// non-empty first X-Forwarded-For hop is therefore tagged remote; one without is
// local loopback.
//
// SECURITY -- this result is ADVISORY (audit-log only), NOT an authorization or
// rate-limit boundary. X-Forwarded-For is NOT trustworthy as a security signal
// here: any LOCAL process that can reach the 127.0.0.1 bind can set an arbitrary
// X-Forwarded-For, so both `remote` and `sourceIp` are spoofable by a co-located
// attacker. That is acceptable for the audit tag (it answers "where did this
// most likely come from" for the operator log), but it MUST NOT gate access or
// key the rate limiter. Authentication is the Bearer-token / signed-session
// check (unaffected by XFF); the rate limiter keys on the unspoofable socket
// peer via `rateLimitKey` below. Tailscale Serve APPENDS to any client-supplied
// X-Forwarded-For rather than replacing it, so a poisoned first hop can survive
// the proxy -- another reason this is advisory-only. See the threat-model notes
// in store/remote-access-setup.md.
export function classifyRequestOrigin(
  xForwardedFor: string | string[] | undefined,
  socketRemoteAddress: string | undefined,
): RequestOrigin {
  const raw = Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor
  const firstHop = raw?.split(',')[0]?.trim()
  if (firstHop) return { remote: true, sourceIp: firstHop }
  return { remote: false, sourceIp: socketRemoteAddress || 'unknown' }
}

// Rate-limit bucket key. SECURITY: this MUST be the socket peer, never the
// X-Forwarded-For-derived sourceIp from classifyRequestOrigin. The dashboard
// binds 127.0.0.1, so any local process can set an arbitrary X-Forwarded-For
// header; keying the login brute-force limiter on that lets an attacker mint
// unlimited distinct buckets and evade the limit entirely. The socket peer is
// the kernel-reported TCP source and cannot be spoofed over a real connection.
// Trade-off: behind the Tailscale Serve proxy every remote client shares the
// proxy's loopback peer (127.0.0.1) = ONE shared bucket. That is acceptable for
// a single-operator, tailnet-private dashboard -- the limiter is a brute-force
// speed-bump, not a fairness device, and a shared bucket fails safe (stricter,
// never looser, than per-client).
export function rateLimitKey(socketRemoteAddress: string | undefined): string {
  return socketRemoteAddress || 'unknown'
}

// Operator-facing access instructions printed on startup. SECURITY: the URL must
// NOT carry the token. A URL with ?token=<root-equivalent-credential> leaks into
// shell history, server/proxy access logs, the browser address bar and referrers.
// We print a tokenless URL and the token on its OWN line; the UI prompts for it
// and stores it client-side (the dashboard still strips a legacy ?token= too).
//
// When DASHBOARD_PUBLIC_URL is set (e.g. the Tailscale Serve URL the dashboard is
// reachable on from off-box), the operator is told to open THAT instead of the
// loopback URL -- a localhost link is useless from a remote device. The token is
// still surfaced on its own line and never appended to the URL, so the public URL
// stays as leak-safe as the local one. An empty/whitespace publicUrl falls back to
// the loopback default, preserving the prior behavior for a plain local install.
export function buildDashboardAccessMessage(port: number, token: string, publicUrl = ''): string {
  // Strip ALL trailing slashes (not just one) before re-appending exactly one,
  // so a publicUrl ending in `/` -- or several `//` -- never yields a double
  // slash in the printed URL (#205 NIT).
  const url = publicUrl.trim() ? publicUrl.trim().replace(/\/+$/, '') + '/' : `http://127.0.0.1:${port}/`
  return [
    '',
    'Dashboard access:',
    `  1. Open in your browser:  ${url}`,
    '  2. When prompted, paste this access token:',
    `     ${token}`,
    '',
    '',
  ].join('\n')
}

// === Username + password credentials (card 2c16a868) ===
// The dashboard historically authenticated with a single high-entropy bearer
// token. To make it usable from a plain browser on any device (no token to
// paste, no Tailscale client), we add an OPTIONAL username + password login.
// The password is NEVER stored in plaintext: we persist a scrypt hash + a
// per-credential random salt at store/.dashboard-credentials.json (mode 0600).
// The bearer token stays valid in parallel as the strong machine credential
// (scripts / curl / agents) AND as an always-available recovery path if the
// operator forgets the password. Set/rotate via scripts/dashboard-set-credentials.mjs.
const DASHBOARD_CREDENTIALS_PATH = join(PROJECT_ROOT, 'store', '.dashboard-credentials.json')

// scrypt output length in bytes. 64 is comfortably above the 32-byte minimum
// and matches the session-secret entropy elsewhere in this file.
const SCRYPT_KEYLEN = 64
// Minimum password length. Enforced at set-time only; a public-facing login
// makes a weak password the dominant risk, so we refuse anything short here and
// document the "pick a strong one" expectation in the operator flow.
export const MIN_PASSWORD_LENGTH = 12

interface StoredCredentials {
  username: string
  salt: string // hex
  hash: string // hex, scryptSync(password, salt, SCRYPT_KEYLEN)
  createdAt: number
}

// undefined = not yet loaded from disk; null = loaded, none configured.
let cachedCredentials: StoredCredentials | null | undefined
// mtime of the credentials file when it was last read. 0 = not yet read / file absent.
let cachedCredentialsMtime = 0

function loadCredentials(): StoredCredentials | null {
  if (cachedCredentials !== undefined) {
    // mtime-recheck: re-read when the file has been replaced externally (AC1).
    try {
      const mtime = existsSync(DASHBOARD_CREDENTIALS_PATH)
        ? statSync(DASHBOARD_CREDENTIALS_PATH).mtimeMs
        : 0
      if (mtime === cachedCredentialsMtime) return cachedCredentials
    } catch { /* stat failed: keep cache to avoid a hot-path retry storm */ }
    // mtime changed or stat failed with a different value: fall through and re-read.
    cachedCredentials = undefined
  }
  try {
    if (existsSync(DASHBOARD_CREDENTIALS_PATH)) {
      const obj = JSON.parse(readFileSync(DASHBOARD_CREDENTIALS_PATH, 'utf-8')) as StoredCredentials
      if (obj && obj.username && obj.salt && obj.hash) {
        cachedCredentials = obj
        try { cachedCredentialsMtime = statSync(DASHBOARD_CREDENTIALS_PATH).mtimeMs } catch { cachedCredentialsMtime = 0 }
        return obj
      }
    }
  } catch { /* fall through: treat unreadable/corrupt file as "none configured" */ }
  cachedCredentials = null
  cachedCredentialsMtime = 0
  return null
}

// True when a username+password has been configured. The frontend reads this
// (via /api/auth/status) to decide whether to show the password form or fall
// back to the token-paste prompt.
export function hasPasswordCredentials(): boolean {
  return loadCredentials() !== null
}

// Constant-time string compare that tolerates differing lengths without leaking
// the length via an early return/throw. Hash both to a fixed 32-byte digest and
// compare those constant-time. (timingSafeEqual throws on length mismatch, which
// would itself be a timing/exception oracle.)
function constantTimeStrEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(String(a)).digest()
  const db = createHash('sha256').update(String(b)).digest()
  return timingSafeEqual(da, db)
}

// Persist a fresh username+password. Random per-credential salt, scrypt hash,
// atomic write mode 0600. Swaps the in-memory cache so a subsequent verify sees
// the new credential WITHOUT a server restart.
export function setDashboardCredentials(username: string, password: string): void {
  const u = String(username ?? '').trim()
  if (!u) throw new Error('username must not be empty')
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  }
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN)
  const rec: StoredCredentials = {
    username: u,
    salt: salt.toString('hex'),
    hash: hash.toString('hex'),
    createdAt: Math.floor(Date.now() / 1000),
  }
  mkdirSync(join(PROJECT_ROOT, 'store'), { recursive: true })
  atomicWriteFileSync(DASHBOARD_CREDENTIALS_PATH, JSON.stringify(rec), { mode: 0o600 })
  cachedCredentials = rec
  try { cachedCredentialsMtime = statSync(DASHBOARD_CREDENTIALS_PATH).mtimeMs } catch { cachedCredentialsMtime = 0 }
  // AC2: rotate the session secret so all previously issued browser sessions are
  // invalidated immediately. Agents use the bearer token (separate path), so they
  // are unaffected. No restart required.
  rotateSessionSecret()
}

// Verify a username+password pair. Returns false when no credentials are
// configured. SECURITY: always runs scrypt (even on unknown username / no creds)
// against a reference value so total response time does not reveal whether the
// username exists or whether password auth is enabled at all (user-enumeration /
// enable-probe resistance). Both the username and the derived hash must match.
export function verifyPassword(username: string, password: string): boolean {
  const creds = loadCredentials()
  // Reference salt/hash: real values when configured, otherwise fixed dummies so
  // the scrypt cost is still paid and the compare still runs (and fails).
  const salt = creds ? Buffer.from(creds.salt, 'hex') : Buffer.alloc(16)
  const expected = creds ? Buffer.from(creds.hash, 'hex') : Buffer.alloc(SCRYPT_KEYLEN)
  let derived: Buffer
  try {
    derived = scryptSync(String(password ?? ''), salt, SCRYPT_KEYLEN)
  } catch {
    return false
  }
  const hashOk = derived.length === expected.length && timingSafeEqual(derived, expected)
  const userOk = creds ? constantTimeStrEqual(String(username ?? ''), creds.username) : false
  return Boolean(creds) && hashOk && userOk
}

// === Session cookie layer ===
// A signed, opaque session value gates the browser UI without the raw access
// token ever living in localStorage. The value is base64url("<payload>.<sig>")
// where payload = "<sid>.<issuedAt>.<expiry>" (seconds) and sig =
// HMAC-SHA256(secret, payload). Verification is STATELESS: a cookie is valid iff
// its signature matches the persistent secret AND it is not past its absolute
// expiry AND its sid is not in the revocation list. Forgery is prevented by the
// signature alone (an attacker cannot mint a valid sig without the secret), so a
// server restart no longer invalidates live sessions -- the earlier in-memory
// "issued sids" gate broke every session on each restart, which on this fleet
// (the dashboard restarts often: supervisor/deploys/watchdog) meant the operator
// was re-prompted for the token constantly. Revocation (logout) IS persisted so
// it survives a restart; entries are pruned once past their own expiry.
const REVOKED_SESSIONS_PATH = join(PROJECT_ROOT, 'store', '.dashboard-revoked-sessions.json')

let sessionSecret: Buffer | null = null
// sid -> absolute expiry (epoch seconds). Loaded lazily from disk so logout
// takes effect immediately AND survives a restart. null = not yet loaded.
let revokedSessions: Map<string, number> | null = null

// Load (and prune) the persisted revocation list. Lazy + cached.
function loadRevoked(): Map<string, number> {
  if (revokedSessions) return revokedSessions
  const m = new Map<string, number>()
  try {
    if (existsSync(REVOKED_SESSIONS_PATH)) {
      const obj = JSON.parse(readFileSync(REVOKED_SESSIONS_PATH, 'utf-8')) as Record<string, number>
      const now = Math.floor(Date.now() / 1000)
      for (const [sid, exp] of Object.entries(obj)) {
        // Drop entries already past expiry: the cookie is expired-rejected anyway.
        if (Number.isFinite(exp) && exp > now) m.set(sid, exp)
      }
    }
  } catch { /* start empty on any read/parse error */ }
  revokedSessions = m
  return m
}

// Persist the revocation list (best-effort, atomic, 0600).
function persistRevoked(m: Map<string, number>): void {
  try {
    mkdirSync(join(PROJECT_ROOT, 'store'), { recursive: true })
    const obj: Record<string, number> = {}
    for (const [sid, exp] of m) obj[sid] = exp
    atomicWriteFileSync(REVOKED_SESSIONS_PATH, JSON.stringify(obj), { mode: 0o600 })
  } catch { /* best-effort: a failed write only means logout may not survive restart */ }
}

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

// Mass-invalidate EVERY active session in one call ("log everyone out"). Every
// existing cookie is signed with the current session secret, so generating a
// fresh secret (and swapping the in-memory copy) makes every previously issued
// cookie's signature fail verifySession() immediately -- no restart required.
// This is the clean, server-side equivalent of the old manual recovery
// (rm store/.dashboard-session-secret + restart). It is auth-gated by the global
// /api/* bearer-token check, like every admin route. The revocation list is also
// cleared: those per-session entries only existed to reject cookies signed with
// the now-defunct secret, so they are dead weight after a rotation.
export function rotateSessionSecret(): void {
  const fresh = randomBytes(32)
  mkdirSync(join(PROJECT_ROOT, 'store'), { recursive: true })
  atomicWriteFileSync(SESSION_SECRET_PATH, fresh.toString('hex'), { mode: 0o600 })
  sessionSecret = fresh
  // Drop the now-obsolete revocation list: every cookie it named is already
  // signature-rejected under the new secret. Persist the empty list so a restart
  // doesn't reload stale entries.
  revokedSessions = new Map()
  persistRevoked(revokedSessions)
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
  // Stateless validity: a matching signature proves we minted it (no issued-set
  // needed, so sessions survive a restart). Only an explicit logout revokes.
  if (loadRevoked().has(sid)) return { valid: false, expired: false }
  const exp = Number(expiry)
  if (!Number.isFinite(exp)) return { valid: false, expired: false }
  if (Math.floor(nowMs / 1000) >= exp) return { valid: false, expired: true, sid }
  return { valid: true, expired: false, sid }
}

// Revoke a single session (logout). Idempotent. Persisted so the logout
// survives a server restart (until the cookie's own expiry, after which it is
// expired-rejected and the entry is pruned on the next load).
export function revokeSession(value: string | undefined): void {
  if (!value) return
  let decoded: string
  try {
    const b64 = value.replace(/-/g, '+').replace(/_/g, '/')
    decoded = Buffer.from(b64, 'base64').toString('utf-8')
  } catch { return }
  const parts = decoded.split('.')
  const sid = parts[0]
  if (!sid) return
  const exp = Number(parts[2])
  const m = loadRevoked()
  m.set(sid, Number.isFinite(exp) ? exp : Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS)
  persistRevoked(m)
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
  // Drop the in-memory revocation cache so the next call reloads from disk --
  // this models a server restart (the very case the stateless fix targets).
  revokedSessions = null
  // Drop the session secret so tests that rotate credentials get a fresh secret.
  sessionSecret = null
  // Drop the credentials cache too, so a test that writes/removes the creds file
  // between cases sees the fresh on-disk state.
  cachedCredentials = undefined
  cachedCredentialsMtime = 0
}

// Test-only: set the cached credentials mtime directly, simulating a state where
// the cache was loaded at time T but the file has since been replaced externally.
// Used to test AC1 mtime-recheck without requiring a real filesystem timestamp race.
export function __setCredentialsMtimeForTests(mtime: number): void {
  cachedCredentialsMtime = mtime
}
