// Zepp credential reader (WELL-018 / card 8001dd41).
// Reads a 0600 creds file an OPERATOR fills (never an agent -- the token value
// must never enter agent/LLM context; see R5 adb-token guard). Never committed
// or logged. Uses the {file:} pointer discipline.
//
// Supports two modes:
//   password mode: {"email": "...", "password": "..."}          -- cloud-pull with Huami login
//   token mode:    {"apptoken": "...", "userid": "...", "region": "de2"}
//                  (or legacy {"token": "..."})                  -- direct app session token
//
// Token mode targets the unofficial Huami/Zepp cloud: the `apptoken` header
// (NOT Bearer) on host api-mifit-<region>.zepp.com with `userid` in the request.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ZeppCreds } from './auth.js'

const PROJECT_ROOT = process.env.MARVEEN_ROOT ?? process.cwd()

// The creds file path. Default is store/zepp/.creds.json, but an operator may
// place the file outside the repo (e.g. /home/domin/.zepp-creds.json) and point
// to it via ZEPP_CREDS_PATH -- keeping the secret off the repo tree entirely.
export function resolveDefaultCredsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ZEPP_CREDS_PATH
  if (override && override.trim()) return override.trim()
  return join(PROJECT_ROOT, 'store', 'zepp', '.creds.json')
}

export const DEFAULT_CREDS_PATH = resolveDefaultCredsPath()

export type ZeppCredsOrToken =
  | ({ mode: 'password' } & ZeppCreds)
  | { mode: 'token'; token: string; userid?: string; region?: string }

export function readZeppCredsOrToken(path: string = resolveDefaultCredsPath()): ZeppCredsOrToken {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`Zepp creds not found at ${path} -- run the credential intake procedure`)
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>

  // token mode -- preferred shape carries the app session token + who + where.
  const apptoken = parsed['apptoken']
  if (typeof apptoken === 'string' && apptoken) {
    const userid = typeof parsed['userid'] === 'string' ? parsed['userid'] : undefined
    const region = typeof parsed['region'] === 'string' ? parsed['region'] : undefined
    return { mode: 'token', token: apptoken, userid, region }
  }
  // legacy token shape (Google-login flow) -- no userid/region.
  if (typeof parsed['token'] === 'string' && parsed['token']) {
    return { mode: 'token', token: parsed['token'] }
  }
  if (parsed['email'] && parsed['password'] && typeof parsed['email'] === 'string' && typeof parsed['password'] === 'string') {
    return { mode: 'password', email: parsed['email'], password: parsed['password'] }
  }
  throw new Error(
    'Zepp creds file must contain {"apptoken":"...","userid":"...","region":"..."}, ' +
    'legacy {"token":"..."}, or {"email":"...","password":"..."} -- run the credential intake procedure',
  )
}

// Backward-compat alias for existing callers that expect ZeppCreds
export function readZeppCreds(path: string = resolveDefaultCredsPath()): ZeppCreds {
  const result = readZeppCredsOrToken(path)
  if (result.mode === 'token') {
    throw new Error('Zepp creds file contains a token (not email+password) -- use readZeppCredsOrToken instead')
  }
  return { email: result.email, password: result.password }
}
