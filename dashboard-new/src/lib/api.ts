// Read-only API client for the :3420 backend. F0+F1 perform GET requests only
// (INV-2 / AC-G2): no post/put/delete helper exists in this module by design.

const TOKEN_STORAGE_KEY = 'noa-api-token'

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
  const url = new URL(window.location.href)
  url.searchParams.delete('token')
  window.history.replaceState({}, '', url.pathname + url.search + url.hash)
}

/**
 * One-time deep-link login (mirrors web/app.js). dashboard-new keeps its bearer
 * token under its OWN localStorage key, separate from the legacy web/ app, so a
 * first visit to /v2 would otherwise land on the "Authentication required"
 * screen. If the URL carries `?token=<value>`, persist it and strip it from the
 * address bar (so it never lingers in history or a shared link). This is the
 * same entry path used for mobile onboarding. Returns true when a token was
 * captured. Dependencies are injectable for testing.
 */
export function captureTokenFromUrl(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
  persist: (token: string) => void = (token) => {
    try {
      localStorage.setItem(TOKEN_STORAGE_KEY, token)
    } catch {
      /* storage unavailable (private mode) -- nothing else we can do */
    }
  },
  stripUrl: () => void = defaultStripToken,
): boolean {
  const token = new URLSearchParams(search).get('token')
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
