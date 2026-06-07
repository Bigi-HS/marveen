import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'

// A single bearer token gates every /api/* route. It is loaded from
// DASHBOARD_TOKEN if set, otherwise persisted at store/.dashboard-token
// (mode 0600) and auto-generated on first run. Static assets (/, /index.html,
// /style.css, /app.js, /avatars/*) and the auth-status endpoint stay public
// so the UI can bootstrap itself.
const DASHBOARD_TOKEN_PATH = join(PROJECT_ROOT, 'store', '.dashboard-token')

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
