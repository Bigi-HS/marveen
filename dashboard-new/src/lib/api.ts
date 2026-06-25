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
