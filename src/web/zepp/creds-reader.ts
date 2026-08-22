// Zepp credential reader (WELL-018).
// Reads store/zepp/.creds.json -- a 0600 file Boss fills via terminal,
// never committed or logged. Uses the {file:} pointer discipline.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ZeppCreds } from './auth.js'

const PROJECT_ROOT = process.env.MARVEEN_ROOT ?? process.cwd()
export const DEFAULT_CREDS_PATH = join(PROJECT_ROOT, 'store', 'zepp', '.creds.json')

export function readZeppCreds(path: string = DEFAULT_CREDS_PATH): ZeppCreds {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(`Zepp creds not found at ${path} -- run the credential intake procedure`)
  }
  const parsed = JSON.parse(raw) as Partial<ZeppCreds>
  if (!parsed.email || !parsed.password) {
    throw new Error('Zepp creds file is missing email or password -- run the credential intake procedure')
  }
  return { email: parsed.email, password: parsed.password }
}
