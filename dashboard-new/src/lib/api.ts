// Read-only API client for the :3420 backend. F0+F1 perform GET requests only
// (INV-2 / AC-G2): no post/put/delete helper exists in this module by design.

export const TOKEN_STORAGE_KEY = 'noa-api-token'

/**
 * Persist a bearer token to the same store getToken() reads. No-op (swallows) on
 * a storage error (private mode / quota) -- there is nothing else we can do and a
 * throw here would crash the connect UI.
 */
export function saveToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token)
  } catch {
    /* storage unavailable -- nothing else we can do */
  }
}

/**
 * Extract a bearer token from manual paste input (first-run connect on the
 * installable app, where the #token= deep-link fragment never reaches the
 * webview). Accepts a full pairing URL (`<origin>/v2/#token=<jwt>`), a bare
 * `#token=`/`?token=` fragment, or a raw JWT. Returns the trimmed token, or null
 * when nothing usable is found. Unlike captureTokenFromUrl (which is deliberately
 * fragment-only for the automatic deep-link), this is lenient on `?token=` too
 * because a human is pasting whatever they copied.
 */
export function parseTokenInput(input: string): string | null {
  const raw = (input ?? '').trim()
  if (!raw) return null
  const match = raw.match(/[#?&]token=([^#?&\s]+)/)
  if (match) return match[1] || null
  // A URL that carries no token= is not a usable token.
  if (/^https?:\/\//i.test(raw)) return null
  // Otherwise treat the whole string as a raw token. A JWT never contains
  // whitespace, so a multi-word paste is an artifact, not a token.
  if (/\s/.test(raw)) return null
  return raw
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * Resolve the bearer token (AC-G5): build-time env var first, then localStorage.
 * Never hardcoded in source -- returns null when neither is set (callers surface
 * the "Authentication required" screen, edge case in section 7).
 */
export function getToken(): string | null {
  const fromEnv = import.meta.env.VITE_DASHBOARD_TOKEN
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY)
  } catch {
    return null
  }
}

function defaultStripToken(): void {
  if (typeof window === 'undefined') return
  // Remove the hash entirely -- the token was in the fragment, not the query string
  window.history.replaceState({}, '', window.location.pathname + window.location.search)
}

/**
 * One-time deep-link login (mirrors web/app.js). dashboard-new keeps its bearer
 * token under its OWN localStorage key, separate from the legacy web/ app, so a
 * first visit to /v2 would otherwise land on the "Authentication required"
 * screen. If the URL carries `#token=<value>`, persist it and strip it from the
 * address bar (so it never lingers in history or a shared link). The token is
 * passed as a URL fragment (#) rather than a query string (?) so it is never
 * sent to the server in HTTP requests or server logs (SEC-112 #929).
 * Returns true when a token was captured. Dependencies are injectable for testing.
 */
export function captureTokenFromUrl(
  hash: string = typeof window !== 'undefined' ? window.location.hash : '',
  persist: (token: string) => void = saveToken,
  stripUrl: () => void = defaultStripToken,
): boolean {
  // Only read from fragment (#token=...) -- query string (?token=...) is no longer supported
  const token = hash.startsWith('#') ? new URLSearchParams(hash.slice(1)).get('token') : null
  if (!token) return false
  persist(token)
  stripUrl()
  return true
}

/** Pure header builder (AC-G5). Adds Authorization only when a token exists. */
export function buildAuthHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

/** GET a JSON resource. Throws ApiError(status) on a non-2xx response. */
export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: 'GET',
    headers: buildAuthHeaders(getToken()),
    credentials: 'same-origin',
    signal,
  })
  if (!res.ok) {
    throw new ApiError(res.status, `GET ${path} failed: ${res.status}`)
  }
  return (await res.json()) as T
}
