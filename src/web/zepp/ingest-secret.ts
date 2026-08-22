// Reads the HC ingest token from store/zepp/.ingest-token (0600).
// Env var ZEPP_INGEST_TOKEN overrides for test/CI environments.
// The token gate is load-bearing: the ingest endpoint is public via Cloudflare tunnel.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PROJECT_ROOT = process.env.MARVEEN_ROOT ?? process.cwd()
export const DEFAULT_INGEST_TOKEN_PATH = join(PROJECT_ROOT, 'store', 'zepp', '.ingest-token')

export function readIngestToken(path: string = DEFAULT_INGEST_TOKEN_PATH): string {
  if (process.env.ZEPP_INGEST_TOKEN) return process.env.ZEPP_INGEST_TOKEN
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    throw new Error(`Zepp ingest token not found at ${path} -- create it with: echo '<token>' > ${path} && chmod 600 ${path}`)
  }
}
