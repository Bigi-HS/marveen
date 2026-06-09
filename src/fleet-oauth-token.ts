import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from './config.js'

// TypeScript counterpart of scripts/lib/fleet-oauth-env.sh (PR #85). The bash
// helper is SOURCED by shell launch paths; SDK-spawned launches (the heartbeat
// worker) cannot source a shell script, so they read the token here and pass it
// as an env var to the spawn.
//
// Precedence mirrors the helper exactly: the env-file's CLAUDE_CODE_OAUTH_TOKEN
// line wins, else the raw token file. Returns the BARE bearer token (never a
// JSON blob) or null when no token file is present -- callers then fall back to
// the symlinked .credentials.json.
//
// Hardening (Chad's PR #85 medium flag): the env-file is STRICT-PARSED for the
// single KEY=VALUE line, never `source`d, so a malformed/hostile file can never
// execute code. The shape is validated so a garbage value is treated as absent.
// The value is never logged.
const ENV_FILE = join(PROJECT_ROOT, 'store', 'fleet-oauth.env')
const TOKEN_FILE = join(PROJECT_ROOT, 'store', '.claude-oauth-token')
const TOKEN_RE = /^sk-ant-[A-Za-z0-9_-]{20,200}$/

export function readFleetOauthToken(): string | null {
  try {
    if (existsSync(ENV_FILE)) {
      for (const raw of readFileSync(ENV_FILE, 'utf-8').split('\n')) {
        const m = /^CLAUDE_CODE_OAUTH_TOKEN=(.*)$/.exec(raw.trim())
        if (m) {
          const v = m[1].replace(/^["']|["']$/g, '').trim()
          return TOKEN_RE.test(v) ? v : null
        }
      }
    }
  } catch { /* fall through to the raw token file */ }
  try {
    if (existsSync(TOKEN_FILE)) {
      const v = readFileSync(TOKEN_FILE, 'utf-8').replace(/[\r\n]/g, '').trim()
      return TOKEN_RE.test(v) ? v : null
    }
  } catch { /* no readable token -> null */ }
  return null
}
