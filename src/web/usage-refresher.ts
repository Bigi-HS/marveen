// Claude usage refresher (card 7fe5662f) -- reads Dominik's OWN claude.ai usage
// (5h + weekly window %) so the fleet dashboard can show it without opening
// claude.ai/settings/usage. Chad security design-gate PASSED 2026-07-19 (0 BLOCK)
// with 5 MANDATORY guards; this module implements them.
//
// The whole feature is DORMANT behind a feature-flag: with no store/.claude-session
// file present, refreshUsageOnce() returns feature-absent and the route serves a
// 503, so the dashboard ships safe before the credential is ever provided.
//
// SECURITY MODEL (the guards this module enforces):
//   [Storage] the credential lives ONLY in store/.claude-session, mode 0600.
//   [G1] readClaudeSession() is the sole reader; the {sessionKey,cfClearance}
//        pair stays in a closed scope -- it never enters config.ts / process.env
//        and is never cached in the derived state.
//   [G2] not one logger.* / console call here includes a sessionKey/cfClearance.
//        The cookie value only ever appears in an outbound request Cookie header.
//   [G3] the derived state (UsageState) is ONLY {fiveHour,weekly,stale}; the
//        credential is never a serializable field and never in an Error.message.
//   [Egress] a hardcoded ALLOWED_PREFIXES allowlist; assertAllowedUrl() runs
//        before EVERY fetch, and a mismatch throws (SSRF / inject protection).
//   [Rotation] a 401/403/Cloudflare-challenge degrades to auth-expired; the
//        expired credential value never reaches an error message.
//
// The outbound path follows src/web/github-pr.ts: validate before egress, catch
// network errors without surfacing internals, mask auth errors, and accept an
// injectable fetchImpl + readSession so the whole thing is unit-testable with no
// live claude.ai in CI.

import { readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'

// --- Storage ---------------------------------------------------------------

// The credential file. Mode 0600, gitignored (store/ is covered by .gitignore).
// Holds two lines: sessionKey=... and cfClearance=... (plaintext; Chad ruled
// 0600 sufficient on the single-tenant WSL host -- no keychain/encryption).
export const CLAUDE_SESSION_PATH = join(STORE_DIR, '.claude-session')

export interface ClaudeSession {
  sessionKey: string
  cfClearance: string
}

// [G1] The ONLY reader of the credential. Returns null when the file is absent
// or incomplete (feature-absent, NOT an error). The {sessionKey,cfClearance}
// stays in the returned object's closed scope; callers must never widen it into
// config / process.env / the derived cache.
export function readClaudeSession(): ClaudeSession | null {
  let raw: string
  try {
    raw = readFileSync(CLAUDE_SESSION_PATH, 'utf-8')
  } catch {
    return null // file absent -> feature-absent
  }
  let sessionKey = ''
  let cfClearance = ''
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1).trim()
    if (key === 'sessionKey') sessionKey = val
    else if (key === 'cfClearance') cfClearance = val
  }
  if (!sessionKey || !cfClearance) return null
  return { sessionKey, cfClearance }
}

// Writes the credential file with a strict 0600 mode (mkdir + write + chmod).
// Provided for the provisioning step; never called on the read path.
export function writeClaudeSession(session: ClaudeSession): void {
  mkdirSync(STORE_DIR, { recursive: true })
  writeFileSync(
    CLAUDE_SESSION_PATH,
    `sessionKey=${session.sessionKey}\ncfClearance=${session.cfClearance}\n`,
    { mode: 0o600 },
  )
  chmodSync(CLAUDE_SESSION_PATH, 0o600) // enforce even if the file pre-existed
}

// --- Egress allowlist ([Egress] guard) -------------------------------------

// The ONLY two prefixes this module may ever fetch: the org-discovery endpoint
// and the usage endpoint, both on claude.ai. Hardcoded, not env-derived, so the
// refresher can never be re-pointed. assertAllowedUrl() asserts the ASSEMBLED
// URL (the orgId comes from discovery -> treated as untrusted input).
export const ALLOWED_PREFIXES: readonly string[] = [
  'https://claude.ai/api/organizations/',
  'https://claude.ai/api/usage',
]

// The org-discovery endpoint (returns the account's organization UUID).
export const CLAUDE_ORG_PATH = 'https://claude.ai/api/organizations/'

// The usage endpoint path segment appended under the org.
//
// MUST be confirmed via live discovery before the panel is provisioned (spec
// section 1). claude.ai/settings/usage calls an undocumented internal endpoint;
// the exact path + response field names require a logged-in XHR capture. Until
// then this is a best-effort placeholder -- the parser, staleness gate, egress
// allowlist, and degrade logic are all validated without it, and the whole
// feature is dormant behind the feature-flag.
export const CLAUDE_USAGE_PATH = 'usage' // placeholder: e.g. `${org}/usage`

// Throws if `url` is not one of the two blessed endpoints. Parsed with the URL
// WHATWG parser first so credential-in-host ("claude.ai@evil") and scheme-switch
// breakouts are caught, then matched on the normalized href.
//
// The org prefix on its own is too broad (it would permit
// /api/organizations/<uuid>/chat_conversations), so we do NOT bare-prefix-match
// it: an org URL is allowed ONLY when it is the bare discovery endpoint or ends
// in `/usage` -- exactly the two calls the refresher makes. This keeps the guard
// an SSRF backstop, not a wide-open claude.ai proxy.
export function assertAllowedUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new EgressDeniedError()
  }
  if (parsed.protocol !== 'https:') throw new EgressDeniedError()
  if (parsed.host !== 'claude.ai') throw new EgressDeniedError()
  const href = parsed.href
  const orgPrefix = ALLOWED_PREFIXES[0] // https://claude.ai/api/organizations/
  const usagePrefix = ALLOWED_PREFIXES[1] // https://claude.ai/api/usage
  const isDiscovery = href === orgPrefix
  const isOrgUsage = href.startsWith(orgPrefix) && parsed.pathname.endsWith(`/${CLAUDE_USAGE_PATH}`)
  const isDirectUsage = href.startsWith(usagePrefix)
  if (!isDiscovery && !isOrgUsage && !isDirectUsage) {
    throw new EgressDeniedError()
  }
}

// Assembles the usage URL from a (trusted) prefix + a (discovery-sourced,
// UNtrusted) orgId. encodeURIComponent on the orgId prevents a path/host breakout
// via slashes or reserved characters; assertAllowedUrl is the backstop.
export function buildUsageUrl(orgPrefix: string, orgId: string): string {
  return `${orgPrefix}${encodeURIComponent(orgId)}/${CLAUDE_USAGE_PATH}`
}

// --- Errors ([G3]: never carry the credential in a message) -----------------

// A fixed, credential-free auth-expired signal. Distinct type so refreshUsageOnce
// can map it to the rotation degrade state without pattern-matching a string.
export class UsageAuthError extends Error {
  constructor() {
    super('claude.ai session auth expired or challenged')
    this.name = 'UsageAuthError'
  }
}

// A fixed, credential-free egress-denied signal.
export class EgressDeniedError extends Error {
  constructor() {
    super('usage refresher: egress URL not on the allowlist')
    this.name = 'EgressDeniedError'
  }
}

// --- Parser ----------------------------------------------------------------

export interface UsageWindow {
  pct: number
  resetAt: string
}

export interface ParsedUsage {
  fiveHour: UsageWindow
  weekly: UsageWindow
}

// The derived, credential-free state ([G3]). This is the ONLY thing that leaves
// this module for /api/usage/current.
export interface UsageState {
  fiveHour: UsageWindow
  weekly: UsageWindow
  stale: boolean
}

function clampPct(v: unknown): number | null {
  if (typeof v !== 'number' || !isFinite(v)) return null
  return Math.round(Math.min(Math.max(v, 0), 100))
}

function parseWindow(w: unknown): UsageWindow | null {
  if (!w || typeof w !== 'object') return null
  const o = w as Record<string, unknown>
  const pct = clampPct(o['utilization'])
  const resetAt = o['resets_at']
  if (pct === null || typeof resetAt !== 'string') return null
  return { pct, resetAt }
}

// Maps the (undocumented, discovery-confirmed) raw usage JSON into the derived
// {fiveHour,weekly} shape. Returns null on any malformed / missing-window
// payload so a shape change degrades gracefully instead of crashing. The field
// names (`five_hour`/`seven_day`/`utilization`/`resets_at`) MUST be confirmed at
// live discovery (spec section 1); see usage-refresher.test.ts SAMPLE_USAGE.
export function parseUsage(raw: unknown): ParsedUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const fiveHour = parseWindow(o['five_hour'])
  const weekly = parseWindow(o['seven_day'])
  if (!fiveHour || !weekly) return null
  return { fiveHour, weekly }
}

// --- Staleness gate --------------------------------------------------------

// True when the last successful refresh is null or older than ttlMs.
export function isStale(lastSuccessMs: number | null, nowMs: number, ttlMs: number): boolean {
  if (lastSuccessMs === null) return true
  return nowMs - lastSuccessMs > ttlMs
}

// --- Refresh (network path) ------------------------------------------------

export type RefreshResult =
  | { ok: true; usage: ParsedUsage; lastSuccessMs: number }
  | { ok: false; reason: 'feature-absent' | 'auth-expired' | 'unavailable' }

export interface RefreshDeps {
  readSession?: () => ClaudeSession | null
  fetchImpl?: typeof fetch
  nowMs?: () => number
}

// Browser-like UA -- Cloudflare rejects non-browser UAs (same lesson as the Groq
// UA-fix, PR#282). This replays Dominik's OWN session to read HIS OWN usage.
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'

// Builds the request headers. The credential is placed ONLY here, in the Cookie
// header of the outbound request -- never returned, never logged ([G1]/[G2]).
function sessionHeaders(session: ClaudeSession): Record<string, string> {
  return {
    Cookie: `sessionKey=${session.sessionKey}; cf_clearance=${session.cfClearance}`,
    'User-Agent': BROWSER_UA,
    Accept: 'application/json',
  }
}

// Discovers the account's organization UUID. Throws UsageAuthError on 401/403,
// EgressDeniedError if the assembled URL is off-allowlist, and a generic Error
// on any other failure -- NONE of which carry the credential.
async function discoverOrgId(
  doFetch: typeof fetch,
  headers: Record<string, string>,
): Promise<string> {
  assertAllowedUrl(CLAUDE_ORG_PATH)
  const res = await doFetch(CLAUDE_ORG_PATH, { headers })
  if (res.status === 401 || res.status === 403) throw new UsageAuthError()
  if (!res.ok) throw new Error(`org discovery failed (${res.status})`)
  const body = (await res.json()) as Array<{ uuid?: string }> | null
  const uuid = Array.isArray(body) ? body[0]?.uuid : undefined
  if (typeof uuid !== 'string' || !uuid) throw new Error('org discovery: no uuid')
  return uuid
}

// Runs one refresh. Pure control-flow around the injected fetch/session so it is
// fully unit-tested with no live claude.ai. Maps every failure to a
// credential-free RefreshResult; a caught error is NEVER re-surfaced with its
// original message ([G2]/[G3]).
export async function refreshUsageOnce(deps: RefreshDeps = {}): Promise<RefreshResult> {
  const readSession = deps.readSession ?? readClaudeSession
  const doFetch = deps.fetchImpl ?? fetch
  const now = deps.nowMs ?? (() => Date.now())

  const session = readSession()
  if (!session) return { ok: false, reason: 'feature-absent' } // [Feature-flag]

  const headers = sessionHeaders(session)
  try {
    const orgId = await discoverOrgId(doFetch, headers)
    const usageUrl = buildUsageUrl(CLAUDE_ORG_PATH, orgId)
    assertAllowedUrl(usageUrl) // [Egress] assert the ASSEMBLED URL before fetch
    const res = await doFetch(usageUrl, { headers })
    if (res.status === 401 || res.status === 403) throw new UsageAuthError()
    if (!res.ok) throw new Error(`usage fetch failed (${res.status})`)
    const usage = parseUsage(await res.json())
    if (!usage) return { ok: false, reason: 'unavailable' } // shape changed
    return { ok: true, usage, lastSuccessMs: now() }
  } catch (err) {
    // [Rotation] auth failures degrade to auth-expired; everything else to
    // unavailable. We branch on the error TYPE, never on its message, and we do
    // NOT log or surface the original error object (it could carry request
    // internals). Log only a safe, static string ([G2]).
    if (err instanceof UsageAuthError) {
      logger.warn('Claude usage refresh: auth expired / challenged (re-auth needed)')
      return { ok: false, reason: 'auth-expired' }
    }
    logger.warn('Claude usage refresh: endpoint unavailable (degraded)')
    return { ok: false, reason: 'unavailable' }
  }
}

// --- Derived state ---------------------------------------------------------

// Projects a cached refresh outcome into the credential-free UsageState ([G3]).
// Only produces a state when there is a successful cached usage; a stale-but-
// present cache is flagged stale:true.
export function toDerived(
  cached: { ok: true; usage: ParsedUsage; lastSuccessMs: number },
  nowMs: number,
  ttlMs: number,
): UsageState {
  return {
    fiveHour: cached.usage.fiveHour,
    weekly: cached.usage.weekly,
    stale: isStale(cached.lastSuccessMs, nowMs, ttlMs),
  }
}

// --- Background runner ------------------------------------------------------

// TTL after which a cached usage is considered stale (surfaced as stale:true).
export const USAGE_TTL_MS = 20 * 60 * 1000 // 20 min (poll is 15 min)
const REFRESH_INTERVAL_MS = 15 * 60 * 1000 // 15 min
const BOOT_OFFSET_MS = 10_000 // 10s after boot

// In-memory cache of the latest outcome. Holds ONLY derived usage + a reason on
// failure -- never the credential ([G1]/[G3]).
export interface UsageCache {
  ok: boolean
  usage: ParsedUsage | null
  lastSuccessMs: number | null
  reason: 'feature-absent' | 'auth-expired' | 'unavailable' | null
}

let cache: UsageCache = { ok: false, usage: null, lastSuccessMs: null, reason: 'feature-absent' }

// Reads the current derived state for the route. Returns null when there has
// never been a successful refresh (feature-absent / auth-expired / cold-boot) so
// the route serves a 503; a present-but-stale cache returns stale:true.
export function getUsageState(nowMs: number = Date.now()): UsageState | null {
  if (!cache.usage || cache.lastSuccessMs === null) return null
  return toDerived(
    { ok: true, usage: cache.usage, lastSuccessMs: cache.lastSuccessMs },
    nowMs,
    USAGE_TTL_MS,
  )
}

// The last failure reason, for the route to distinguish feature-absent (503
// feature-absent) from auth-expired (503 + reason:'auth-expired').
export function getUsageReason(): UsageCache['reason'] {
  return cache.usage ? null : cache.reason
}

async function tick(): Promise<void> {
  const result = await refreshUsageOnce()
  if (result.ok) {
    cache = { ok: true, usage: result.usage, lastSuccessMs: result.lastSuccessMs, reason: null }
  } else {
    // Keep the last good usage (for graceful stale display) but record the reason.
    cache = { ...cache, ok: false, reason: result.reason }
  }
}

// Starts the 15-min background refresher (10s boot offset). Returns the interval
// handle so src/web.ts can clear it on server.close(). unref() so it never holds
// the process open during shutdown.
export function startUsageRefresher(): NodeJS.Timeout {
  const boot = setTimeout(() => void tick(), BOOT_OFFSET_MS)
  boot.unref()
  const interval = setInterval(() => void tick(), REFRESH_INTERVAL_MS)
  interval.unref()
  return interval
}

// Test-only cache reset so route tests start from a known state.
export function __resetUsageCache(next?: Partial<UsageCache>): void {
  cache = { ok: false, usage: null, lastSuccessMs: null, reason: 'feature-absent', ...next }
}
