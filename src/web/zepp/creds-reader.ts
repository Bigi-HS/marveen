// Zepp credential reader (WELL-018).
// Reads store/zepp/.creds.json -- a 0600 file Boss fills via terminal,
// never committed or logged. Uses the {file:} pointer discipline.
//
// Supports two modes:
//   password mode: {"email": "...", "password": "..."} -- cloud-pull with Huami login
//   token mode:    {"token": "..."}                    -- direct access token (Google-login flow)

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ZeppCreds } from './auth.js'

const PROJECT_ROOT = process.env.MARVEEN_ROOT ?? process.cwd()
export const DEFAULT_CREDS_PATH = join(PROJECT_ROOT, 'store', 'zepp', '.creds.json')

export type ZeppCredsOrToken =
  | ({ mode: 'password' } & ZeppCreds)
  | { mode: 'token'; token: string }

export function readZeppCredsOrToken(path: string = DEFAULT_CREDS_PATH): ZeppCredsOrToken {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`Zepp creds not found at ${path} -- run the credential intake procedure`)
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>
  if (parsed['token'] && typeof parsed['token'] === 'string') {
    return { mode: 'token', token: parsed['token'] }
  }
  if (parsed['email'] && parsed['password'] && typeof parsed['email'] === 'string' && typeof parsed['password'] === 'string') {
    return { mode: 'password', email: parsed['email'], password: parsed['password'] }
  }
  throw new Error('Zepp creds file must contain either {"token":"..."} or {"email":"...","password":"..."} -- run the credential intake procedure')
}

// Cloud band_data (de2) creds -- the captured apptoken path (card 8001dd41).
// Lives OUTSIDE the repo tree at ~/.zepp-creds.json (0600), written by NoA from a
// PCAPdroid capture. The apptoken value is read only into process memory and sent
// as the request header; it is never logged or returned in any other form.
export const CLOUD_CREDS_PATH = join(process.env.HOME ?? '/home/domin', '.zepp-creds.json')

// region code -> Huami/Zepp API host. de2 is Boss's account region (confirmed via MITM 09-08).
const REGION_HOSTS: Record<string, string> = {
  de2: 'api-mifit-de2.zepp.com',
  us2: 'api-mifit-us2.zepp.com',
  cn2: 'api-mifit-cn2.zepp.com',
}

// Boss's account data region -- fallback DATA host when the creds file names neither an explicit
// host nor a region. The email+password login path mints a token but carries no host, so the
// pull defaults to de2 here.
const DEFAULT_REGION = 'de2'

export interface ZeppCloudCreds {
  appToken: string
  userId: string
  host: string
}

/**
 * Read the cloud band_data creds, tolerating both the captured file's field names
 * (app_token/user_id/host/region_host) and the documented guide shape
 * (apptoken/userid/region). Resolves the host from an explicit `host` field or by
 * mapping a region code.
 */
export function readZeppCloudCreds(path: string = CLOUD_CREDS_PATH): ZeppCloudCreds {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`Zepp cloud creds not found at ${path} -- run the apptoken capture procedure`)
  }
  const p = JSON.parse(raw) as Record<string, unknown>
  const appToken = (p['app_token'] ?? p['apptoken'] ?? p['token']) as unknown
  const userId = (p['user_id'] ?? p['userid']) as unknown
  const region = (p['region_host'] ?? p['region']) as unknown
  const host = (p['host'] as unknown) ?? (typeof region === 'string' ? REGION_HOSTS[region] : undefined)

  if (typeof appToken !== 'string' || !appToken) {
    throw new Error('Zepp cloud creds file must contain an apptoken (app_token/apptoken/token)')
  }
  if (typeof userId !== 'string' && typeof userId !== 'number') {
    throw new Error('Zepp cloud creds file must contain a user_id/userid')
  }
  if (typeof host !== 'string' || !host) {
    throw new Error('Zepp cloud creds file must contain a host or a known region (de2/us2/cn2)')
  }
  return { appToken, userId: String(userId), host }
}

/**
 * Cloud auth for the accurate-sleep pull, in the two shapes the ~/.zepp-creds.json file can
 * take. `password` mode is the hands-off path (email+password -> server-side login mints a
 * fresh app_token each run); `token` mode is the legacy captured-apptoken path. `host` is the
 * DATA region host for the band_data pull (de2 by default), resolved independently of the auth
 * handshake.
 */
export type ZeppCloudAuth =
  | { mode: 'password'; email: string; password: string; host: string }
  | { mode: 'token'; appToken: string; userId: string; host: string }

/**
 * Read the cloud creds and decide the auth mode. If the file carries email+password we take the
 * hands-off login path (no user_id/app_token needed in the file -- login mints them); otherwise
 * we fall back to the captured-apptoken shape. The data host resolves from an explicit `host`,
 * a region code, or the de2 default. No credential value is logged.
 */
export function readZeppCloudAuth(path: string = CLOUD_CREDS_PATH): ZeppCloudAuth {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`Zepp cloud creds not found at ${path} -- write {"email","password"} (or the captured apptoken shape)`)
  }
  const p = JSON.parse(raw) as Record<string, unknown>
  const region = (p['region_host'] ?? p['region']) as unknown
  const host =
    ((p['host'] as unknown) ??
      (typeof region === 'string' ? REGION_HOSTS[region] : undefined) ??
      REGION_HOSTS[DEFAULT_REGION]) as string

  const email = p['email']
  const password = p['password']
  if (typeof email === 'string' && email && typeof password === 'string' && password) {
    return { mode: 'password', email, password, host }
  }

  // Fall back to the captured-apptoken shape.
  const creds = readZeppCloudCreds(path)
  return { mode: 'token', appToken: creds.appToken, userId: creds.userId, host: creds.host }
}

// Backward-compat alias for existing callers that expect ZeppCreds
export function readZeppCreds(path: string = DEFAULT_CREDS_PATH): ZeppCreds {
  const result = readZeppCredsOrToken(path)
  if (result.mode === 'token') {
    throw new Error('Zepp creds file contains a token (not email+password) -- use readZeppCredsOrToken instead')
  }
  return { email: result.email, password: result.password }
}
