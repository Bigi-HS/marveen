// Pure helpers for the one-time OAuth authorization flow (Part B): turn a
// Desktop-app OAuth client (client_id/secret) into a long-lived refresh token.
// The interactive loopback flow lives in scripts/google-oauth-authorize.ts; the
// testable pieces (URL build, client-JSON parse, code exchange) live here.
//
// Egress: code exchange hits oauth2.googleapis.com (OAUTH_TOKEN_URL, reused from
// google-oauth.ts); the consent URL is an accounts.google.com page the human
// opens in a browser, not a server fetch.
import { OAUTH_TOKEN_URL, type FetchLike } from './google-oauth.js'

export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'

// Minimal scopes (Chad spec): read-only calendar events + send-only gmail.
export const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/gmail.send',
]

const realFetch = fetch as unknown as FetchLike

export interface OAuthClient {
  clientId: string
  clientSecret: string
}

// Desktop-app OAuth client JSON has the shape { installed: { client_id, ... } }.
// Accept `web` and a flat object too, to be forgiving about how it was handed over.
export function parseClientJson(raw: string): OAuthClient {
  const j = JSON.parse(raw) as Record<string, any>
  const node = j.installed ?? j.web ?? j
  const clientId = node?.client_id
  const clientSecret = node?.client_secret
  if (typeof clientId !== 'string' || typeof clientSecret !== 'string') {
    throw new Error(
      'client JSON missing client_id/client_secret (expected a Desktop-app OAuth client)',
    )
  }
  return { clientId, clientSecret }
}

// Build the consent URL. access_type=offline + prompt=consent are required to be
// issued a refresh token (and to be re-issued one on a repeat authorization).
export function buildAuthUrl(
  clientId: string,
  redirectUri: string,
  scopes: string[] = SCOPES,
): string {
  const u = new URL(AUTH_ENDPOINT)
  u.searchParams.set('client_id', clientId)
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', scopes.join(' '))
  u.searchParams.set('access_type', 'offline')
  u.searchParams.set('prompt', 'consent')
  return u.toString()
}

// Exchange the authorization code for tokens. The refresh token is the durable
// artifact we persist; the access token is incidental.
export async function exchangeCodeForTokens(
  client: OAuthClient,
  code: string,
  redirectUri: string,
  fetchFn: FetchLike = realFetch,
): Promise<{ refreshToken: string; accessToken: string }> {
  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  })
  const res = await fetchFn(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`code exchange failed: ${res.status} ${t.slice(0, 200)}`)
  }
  const j = (await res.json()) as { refresh_token?: string; access_token?: string }
  if (!j.refresh_token) {
    throw new Error(
      'code exchange: no refresh_token returned (re-run after a fresh consent; ' +
        'prompt=consent must be set so Google re-issues one)',
    )
  }
  return { refreshToken: j.refresh_token, accessToken: j.access_token ?? '' }
}
