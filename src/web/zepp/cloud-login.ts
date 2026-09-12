// Zepp cloud LOGIN -- email+password -> fresh app_token (hands-off, no capture).
//
// Why this exists: the captured-apptoken path (cloud-band-data.ts) depends on a token the
// phone app rotates (~monthly + per-session), so every re-capture is a manual MITM step and
// a live 401 waits at the end of each token's life. This module logs in server-side from the
// account email+password and mints a FRESH app_token each run, removing the token-burn/401
// dependency entirely. Port of argrento/huami-token v0.8.0 ZeppSession login (MIT).
//
// Flow (two requests):
//   1. POST /v2/registrations/tokens -- body is the AES-128-CBC-encrypted, url-encoded
//      {emailOrPhone,password,...} form. On correct creds the server replies 303 with a
//      Location header carrying ?access=<code>&refresh=<code>.
//   2. POST /v2/client/login -- exchanges the access code for token_info
//      {app_token, login_token, user_id}.
//
// The auth handshake uses the us2 user/registration hosts (region-agnostic; the minted
// app_token is account-global). The accurate-sleep pull still targets the account's DATA
// region host (de2) -- that host resolution lives in creds-reader, not here.
//
// CREDENTIAL DISCIPLINE: the email/password travel only into the encrypted request body; the
// minted app_token/login_token are returned to the caller but NEVER printed or logged by this
// module. No credential or token value is written to stdout anywhere here.

import { createCipheriv, randomUUID } from 'node:crypto'
import { ZeppAuthError } from './puller.js'

// AES-128-CBC parameters that the Zepp app uses to encrypt the credential form (huami-token
// ZEPP_ENCRYPTION_PARAMS). 16-byte key -> AES-128; raw 16-byte IV; PKCS7 padding (Node default).
const AES_KEY = Buffer.from('xeNtBVqzDc6tuNTh')
const AES_IV = Buffer.from('MAAAYAAAAAAAAABg')

// us2 auth hosts -- the registration/login service used regardless of the account's data region.
const DEFAULT_TOKENS_URL = 'https://api-user-us2.zepp.com/v2/registrations/tokens'
const DEFAULT_LOGIN_URL = 'https://api-mifit-us2.zepp.com/v2/client/login'

export interface ZeppLoginDeps {
  fetch: typeof globalThis.fetch
  /** Per-login device id; defaults to a random uuid (the app sends a fresh one each login). */
  deviceId?: string
  /** Override the step-1 token endpoint (default us2 registrations/tokens). */
  tokensUrl?: string
  /** Override the step-2 login endpoint (default us2 client/login). */
  loginUrl?: string
  /** Credential-form region (default us-west-2, the huami-token value). */
  region?: string
  /** Credential-form country code (default US). */
  countryCode?: string
}

export interface ZeppLoginResult {
  /** Fresh app_token -- sent as the `apptoken` header on the band_data pull. */
  appToken: string
  userId: string
  loginToken: string
}

/**
 * AES-128-CBC encrypt the url-encoded credential form (PKCS7 padded). Exported so a golden
 * vector can pin it byte-for-byte against the reference implementation.
 */
export function aesEncrypt(plaintext: string): Buffer {
  const cipher = createCipheriv('aes-128-cbc', AES_KEY, AES_IV)
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
}

/**
 * Build the step-1 credential form exactly as the Zepp app does (field order preserved;
 * `token` appears twice for access+refresh). Values are form-encoded (@ -> %40 etc).
 */
export function buildTokensPayload(email: string, password: string, region: string, countryCode: string): string {
  const p = new URLSearchParams()
  p.append('emailOrPhone', email)
  p.append('state', 'REDIRECTION')
  p.append('client_id', 'HuaMi')
  p.append('password', password)
  p.append('redirect_uri', 'https://s3-us-west-2.amazonaws.com/hm-registration/successsignin.html')
  p.append('region', region)
  p.append('token', 'access')
  p.append('token', 'refresh')
  p.append('country_code', countryCode)
  return p.toString()
}

/** Extract the access + refresh codes from the step-1 303 redirect Location. */
export function parseTokenRedirect(location: string): { access: string; refresh: string } {
  let url: URL
  try {
    url = new URL(location)
  } catch {
    throw new ZeppAuthError(`Zepp login: unparseable redirect location`)
  }
  const access = url.searchParams.get('access')
  const refresh = url.searchParams.get('refresh')
  if (!access || !refresh) {
    throw new ZeppAuthError('Zepp login: no access/refresh token in redirect (bad credentials?)')
  }
  return { access, refresh }
}

/** Build the step-2 login form that exchanges the access code for token_info. */
export function buildLoginPayload(accessCode: string, deviceId: string, countryCode: string): string {
  const p = new URLSearchParams()
  p.append('code', accessCode)
  p.append('device_id', deviceId)
  p.append('device_model', 'android_phone')
  p.append('app_version', '9.12.5')
  p.append('third_name', 'huami')
  p.append('source', 'com.huami.watch.hmwatchmanager:9.12.5:151689')
  p.append('app_name', 'com.huami.midong')
  p.append('country_code', countryCode)
  p.append('grant_type', 'access_token')
  p.append('allow_registration', 'false')
  p.append('lang', 'en')
  return p.toString()
}

/** Pull the app_token / login_token / user_id out of the step-2 login response body. */
export function parseLoginTokenInfo(body: unknown): ZeppLoginResult {
  const tokenInfo = (body as { token_info?: Record<string, unknown> } | null)?.token_info
  const appToken = tokenInfo?.['app_token']
  const loginToken = tokenInfo?.['login_token']
  const userId = tokenInfo?.['user_id']
  if (typeof appToken !== 'string' || !appToken) {
    throw new ZeppAuthError('Zepp login: no app_token in login response')
  }
  if (userId === undefined || userId === null || String(userId) === '') {
    throw new ZeppAuthError('Zepp login: no user_id in login response')
  }
  return {
    appToken,
    userId: String(userId),
    loginToken: typeof loginToken === 'string' ? loginToken : '',
  }
}

const TOKENS_HEADERS: Record<string, string> = {
  appname: 'com.huami.midong',
  app_name: 'com.huami.midong',
  appplatform: 'android_phone',
  'x-hm-ekv': '1', // signals the encrypted-credential body
  'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
}

const LOGIN_HEADERS: Record<string, string> = {
  app_name: 'com.huami.webapp',
  appname: 'com.huami.webapp',
  'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
  accept: 'application/json, text/plain, */*',
}

/**
 * Log in with email+password and return a fresh app_token + user_id. Throws ZeppAuthError on
 * any step failure so the pull-runner/health-guard treats it like an auth failure that needs
 * fresh credentials (rather than silently degrading to missing data).
 */
export async function zeppCloudLogin(email: string, password: string, deps: ZeppLoginDeps): Promise<ZeppLoginResult> {
  const region = deps.region ?? 'us-west-2'
  const countryCode = deps.countryCode ?? 'US'
  const tokensUrl = deps.tokensUrl ?? DEFAULT_TOKENS_URL
  const loginUrl = deps.loginUrl ?? DEFAULT_LOGIN_URL
  const deviceId = deps.deviceId ?? randomUUID()

  // Step 1: encrypted credential exchange -> 303 redirect carrying the access code.
  const encrypted = aesEncrypt(buildTokensPayload(email, password, region, countryCode))
  const tokenRes = await deps.fetch(tokensUrl, {
    method: 'POST',
    headers: TOKENS_HEADERS,
    body: new Uint8Array(encrypted), // raw encrypted bytes as the form body
    redirect: 'manual', // keep the 303 so we can read the Location instead of following it
  })
  if (tokenRes.status !== 303) {
    throw new ZeppAuthError(`Zepp login step 1 expected 303, got ${tokenRes.status}`)
  }
  const location = tokenRes.headers.get('location')
  if (!location) {
    throw new ZeppAuthError('Zepp login step 1: 303 without a Location header')
  }
  const { access } = parseTokenRedirect(location)

  // Step 2: exchange the access code for token_info { app_token, user_id, login_token }.
  const loginRes = await deps.fetch(loginUrl, {
    method: 'POST',
    headers: LOGIN_HEADERS,
    body: buildLoginPayload(access, deviceId, countryCode),
  })
  if (loginRes.status !== 200) {
    throw new ZeppAuthError(`Zepp login step 2 expected 200, got ${loginRes.status}`)
  }
  const body = await loginRes.json().catch(() => null)
  return parseLoginTokenInfo(body)
}
