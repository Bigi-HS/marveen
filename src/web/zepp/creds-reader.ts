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

// Backward-compat alias for existing callers that expect ZeppCreds
export function readZeppCreds(path: string = DEFAULT_CREDS_PATH): ZeppCreds {
  const result = readZeppCredsOrToken(path)
  if (result.mode === 'token') {
    throw new Error('Zepp creds file contains a token (not email+password) -- use readZeppCredsOrToken instead')
  }
  return { email: result.email, password: result.password }
}
