// Zepp/Huami account authentication (WELL-018).
// Uses the unofficial Huami auth endpoint (argrento/huami-token pattern).
// All HTTP is injected via `deps.fetch` so unit tests run without network.
//
// Zepp app (Amazfit Balance) uses the Huami/Zepp cloud -- NOT Zepp Life.
// Auth URL confirmed for the Zepp app flow; endpoint may drift on Zepp infra
// changes (silent-guard: token-refresh 401 must surface as auth_fail alert).

export interface ZeppCreds {
  email: string
  password: string
}

export interface ZeppTokens {
  accessToken: string
  refreshToken: string
  /** Epoch ms when the access token expires */
  expiresAt?: number
}

// Typed error thrown by login/refresh so callers can map it to ZeppPullStatus.
export class ZeppAuthError extends Error {
  readonly type = 'auth_fail' as const
  constructor(message: string) {
    super(message)
    this.name = 'ZeppAuthError'
  }
}

export interface ZeppAuthDeps {
  loginUrl: string
  refreshUrl: string
  fetch: typeof globalThis.fetch
}

// How many seconds before expiry we treat the token as expired (safety margin).
const EXPIRY_MARGIN_MS = 5 * 60 * 1000

export function isTokenExpired(tokens: ZeppTokens): boolean {
  if (!tokens.expiresAt) return true
  return tokens.expiresAt - Date.now() < EXPIRY_MARGIN_MS
}

function parseTokenInfo(body: unknown): ZeppTokens {
  const info = (body as any)?.token_info
  const accessToken: string = info?.access_token
  const refreshToken: string = info?.refresh_token
  if (!accessToken || !refreshToken) {
    throw new ZeppAuthError('Login response missing access_token or refresh_token')
  }
  const expiredIn: number = info?.expired_in ?? 0
  const expiresAt = expiredIn > 0 ? Date.now() + expiredIn * 1000 : undefined
  return { accessToken, refreshToken, expiresAt }
}

export async function zeppLogin(creds: ZeppCreds, deps: ZeppAuthDeps): Promise<ZeppTokens> {
  const res = await deps.fetch(deps.loginUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: creds.email, password: creds.password }),
  })
  if (!res.ok) {
    throw new ZeppAuthError(`Zepp login failed: HTTP ${res.status}`)
  }
  try {
    return parseTokenInfo(await res.json())
  } catch (err) {
    if (err instanceof ZeppAuthError) throw err
    throw new ZeppAuthError(`Zepp login: unexpected response shape -- ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function zeppRefresh(refreshToken: string, deps: ZeppAuthDeps): Promise<ZeppTokens> {
  const res = await deps.fetch(deps.refreshUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
  if (!res.ok) {
    throw new ZeppAuthError(`Zepp token refresh failed: HTTP ${res.status}`)
  }
  try {
    return parseTokenInfo(await res.json())
  } catch (err) {
    if (err instanceof ZeppAuthError) throw err
    throw new ZeppAuthError(`Zepp refresh: unexpected response shape -- ${err instanceof Error ? err.message : String(err)}`)
  }
}

// Default auth endpoints for the Zepp app (Amazfit Balance) flow.
// The Zepp app uses the Huami/Zepp cloud (not Zepp Life / Mi Fit).
export const DEFAULT_AUTH_CONFIG = {
  loginUrl: 'https://account.huami.com/v1/user/login.json',
  refreshUrl: 'https://account.huami.com/v1/user/token.json',
}
