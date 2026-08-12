// Pure helpers for the one-time OAuth authorization flow (Part B): turn a
// Desktop-app OAuth client (client_id/secret) into a long-lived refresh token.
// The interactive loopback flow lives in scripts/google-oauth-authorize.ts; the
// testable pieces (URL build, client-JSON parse, code exchange, and -- since
// SEC-042 -- the loopback code receiver itself) live here.
//
// Egress: code exchange hits oauth2.googleapis.com (OAUTH_TOKEN_URL, reused from
// google-oauth.ts); the consent URL is an accounts.google.com page the human
// opens in a browser, not a server fetch.
import { createServer, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { OAUTH_TOKEN_URL, type FetchLike } from './google-oauth.js'

export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'

// SEC-042 (card 1d2a4fe0, DA-42). The authorize scripts used to call
// `server.listen(PORT)` with no host, which makes Node bind `::` -- every
// interface -- so for five minutes the code receiver accepted connections from
// the LAN. The redirect target is always `http://localhost:<port>/`, so loopback
// is the only address that ever needs to accept one.
export const LOOPBACK_HOST = '127.0.0.1'

// Bounded scope set (SEC-AC3 / F-AC9). v2 grants Claudia full PA capability
// within a hard boundary: read+triage gmail, manage labels/filters/vacation,
// send mail, and full calendar. calendar.events.readonly is DROPPED (superseded
// by the broader `calendar` scope). DENY-listed and intentionally absent:
// the Gmail sharing-settings scope (forwarding/delegation) and the legacy
// full-mail scope (permanent purge). This array is the single hardcoded source;
// no runtime configuration can widen it.
//
// ENG-048: the FULL Drive scope is added (Boss decision 2026-08-01 TG4809 --
// "mindenhez ertsen": Claudia lists/downloads/uploads the WHOLE Drive, not just
// drive.file). Every mutating Drive op is pre-write-backed-up locally + ask-first
// guarded (drive_upload_file). Re-consent re-issues a refresh token carrying this.
export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
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
// `state` is echoed back by the provider on the redirect; pass the value from
// generateState() and hand the same value to awaitLoopbackCode so the receiver
// can tell OUR redirect from anyone else's request (SEC-042). Optional so the
// signature stays back-compatible for callers that do not run a receiver.
export function buildAuthUrl(
  clientId: string,
  redirectUri: string,
  scopes: string[] = SCOPES,
  state?: string,
): string {
  const u = new URL(AUTH_ENDPOINT)
  u.searchParams.set('client_id', clientId)
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', scopes.join(' '))
  u.searchParams.set('access_type', 'offline')
  u.searchParams.set('prompt', 'consent')
  if (state) u.searchParams.set('state', state)
  return u.toString()
}

// 256-bit CSRF nonce for the authorization request (SEC-042). Must come from a
// CSPRNG: the whole point is that a third party cannot guess or replay it.
export function generateState(): string {
  return randomBytes(32).toString('hex')
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

// The receiver renders provider-supplied query values (`error`) into the page it
// shows the human. Those values are attacker-influenceable, so escape rather
// than interpolate raw -- the old page echoed `error` straight into the body.
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c)
}

function respond(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(
    `<html><body style="font-family:sans-serif"><h2>${escapeHtml(message)}</h2></body></html>`,
  )
}

export interface LoopbackCodeOptions {
  // Port to listen on. 0 asks the OS for an ephemeral one (tests).
  port: number
  // Used only as the base for parsing the request URL.
  redirectUri: string
  // The nonce handed to buildAuthUrl; a redirect that does not echo it exactly
  // is refused without ever yielding its code.
  expectedState: string
  timeoutMs?: number
  onListening?: (info: AddressInfo) => void
}

// Stand up the one-shot loopback receiver and resolve the authorization code the
// provider redirects back with. Shared by both authorize scripts: the previous
// per-script copies of this function were byte-identical, which is how the same
// two defects came to live in two places at once.
export function awaitLoopbackCode(opts: LoopbackCodeOptions): Promise<string> {
  const { port, redirectUri, expectedState, timeoutMs = 5 * 60 * 1000, onListening } = opts
  return new Promise((resolveCode, rejectCode) => {
    let settled = false
    const fail = (message: string): void => {
      if (settled) return
      settled = true
      rejectCode(new Error(message))
    }
    const succeed = (code: string): void => {
      if (settled) return
      settled = true
      resolveCode(code)
    }

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', redirectUri)
      const state = url.searchParams.get('state')
      const code = url.searchParams.get('code')
      const err = url.searchParams.get('error')

      // Not a redirect at all (a browser fetching /favicon.ico, a stray probe):
      // answer it and keep waiting rather than tearing the flow down.
      if (state == null && code == null && err == null) {
        respond(res, 404, 'Not found.')
        return
      }

      // State first, and BEFORE the code is looked at: a request that does not
      // carry our exact nonce did not come from the consent URL we printed, so
      // its `code` is not ours to exchange.
      if (state !== expectedState) {
        respond(res, 400, 'Authorization rejected: unexpected state parameter.')
        server.close()
        fail(
          state == null
            ? 'authorization rejected: the redirect carried no state parameter'
            : 'authorization rejected: the state parameter did not match the one we sent',
        )
        return
      }

      if (err != null) {
        respond(res, 400, `Authorization failed: ${err}`)
        server.close()
        fail(`authorization failed: ${err}`)
        return
      }

      if (code == null) {
        respond(res, 400, 'Authorization failed: no code in redirect.')
        server.close()
        fail('authorization failed: no code in redirect')
        return
      }

      respond(res, 200, 'Authorized. You can close this tab.')
      server.close()
      succeed(code)
    })

    server.on('error', (e) => fail(e.message))
    server.listen(port, LOOPBACK_HOST, () => {
      onListening?.(server.address() as AddressInfo)
    })
    setTimeout(() => {
      server.close()
      fail('timed out waiting for the browser redirect')
    }, timeoutMs).unref()
  })
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
