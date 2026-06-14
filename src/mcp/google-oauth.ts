// OAuth token handling for the Claudia Google MCP server. The server holds a
// long-lived refresh token (written once by scripts/google-oauth-authorize.ts,
// stored 0600 under agents/claudia/.claude/channels/google/, gitignored) and
// mints short-lived access tokens from it on demand.
//
// Egress: this module talks ONLY to oauth2.googleapis.com (see OAUTH_TOKEN_URL).
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// The only host this module contacts. *.googleapis.com (Chad egress review).
export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'

export interface GoogleClientCreds {
  clientId: string
  clientSecret: string
  refreshToken: string
}

export interface AccessToken {
  token: string
  // epoch ms at which this access token expires
  expiresAt: number
}

// A minimal fetch shape so tests can inject a stub without pulling in DOM types.
export type FetchLike = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  },
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
}>

const realFetch = fetch as unknown as FetchLike

// Load the OAuth client creds + refresh token from the channel dir's
// oauth-tokens.json (the file written by the one-time authorize helper).
export async function loadGoogleCreds(channelDir: string): Promise<GoogleClientCreds> {
  const raw = await readFile(join(channelDir, 'oauth-tokens.json'), 'utf-8')
  const j = JSON.parse(raw) as Record<string, unknown>
  const clientId = j.client_id
  const clientSecret = j.client_secret
  const refreshToken = j.refresh_token
  if (
    typeof clientId !== 'string' ||
    typeof clientSecret !== 'string' ||
    typeof refreshToken !== 'string'
  ) {
    throw new Error(
      'google oauth creds incomplete (need client_id, client_secret, refresh_token)',
    )
  }
  return { clientId, clientSecret, refreshToken }
}

// Exchange the refresh token for a fresh access token. `now` (epoch ms) is
// injected so expiry is deterministic in tests.
export async function refreshAccessToken(
  creds: GoogleClientCreds,
  now: number,
  fetchFn: FetchLike = realFetch,
): Promise<AccessToken> {
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
    grant_type: 'refresh_token',
  })
  const res = await fetchFn(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`google token refresh failed: ${res.status} ${text.slice(0, 200)}`)
  }
  const j = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!j.access_token) {
    throw new Error('google token refresh: no access_token in response')
  }
  const ttlMs = (j.expires_in ?? 3600) * 1000
  return { token: j.access_token, expiresAt: now + ttlMs }
}

// On-demand access-token cache: returns a valid token, refreshing when the
// current one is within `skewMs` of expiry (or absent).
export class AccessTokenProvider {
  private current: AccessToken | null = null

  constructor(
    private readonly creds: GoogleClientCreds,
    private readonly nowFn: () => number = () => Date.now(),
    private readonly fetchFn: FetchLike = realFetch,
    private readonly skewMs = 60_000,
  ) {}

  async get(): Promise<string> {
    const now = this.nowFn()
    if (this.current && this.current.expiresAt - now > this.skewMs) {
      return this.current.token
    }
    this.current = await refreshAccessToken(this.creds, now, this.fetchFn)
    return this.current.token
  }
}
