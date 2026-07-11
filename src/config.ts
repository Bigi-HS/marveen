import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEnvFile } from './env.js'
import { logger } from './logger.js'
import { getProviderType, getChannelToken, getChannelChatId, type ChannelProviderType } from './channel-provider.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const PROJECT_ROOT = join(__dirname, '..')
export const STORE_DIR = join(PROJECT_ROOT, 'store')
// Post-cutover default (card 57480c07): the live fleet DB is store/noa.db. Code
// that resolves via NOA_DB_PATH (db.ts) uses this only as the fallback; the few
// direct join(STORE_DIR, DB_FILENAME) consumers (heartbeat size stat,
// channel-coordinator ingest) now point at the live DB instead of the frozen
// legacy claudeclaw.db. PID_FILENAME keeps its historical name (pidfile, not a DB).
export const DB_FILENAME = 'noa.db'
export const PID_FILENAME = 'claudeclaw.pid'

const env = readEnvFile()

// ── Boot-knob env resolution helpers (AC-1, AC-1b, AC-2) ────────────────────
// These helpers implement process.env > .env-file > default precedence ONLY for
// the boot-network knobs (WEB_PORT, WEB_HOST). Secrets/tokens keep their .env-file
// source (AC-2) and MUST NOT use these helpers.

export type EnvSource = 'process' | 'file' | 'default'

/** Resolve an integer knob: process.env > file env > fallback.
 *  Invalid process.env values (NaN, <=0) fall through to file/default.
 *  When `opts.max` is set, a value above the cap is treated as invalid and
 *  falls through too -- e.g. WEB_PORT=99999 (> 65535) drops to the .env/default
 *  instead of surfacing only later at server.listen(). The cap applies to both
 *  the process.env and file sources so an out-of-range value is rejected wherever
 *  it comes from. The existing lower-bound behaviour is unchanged (process.env
 *  requires n>0; the file source keeps accepting any finite integer <= max). */
export function resolveIntEnv(
  key: string,
  fileEnv: Record<string, string | undefined>,
  fallback: number,
  opts?: { max?: number },
): { value: number; source: EnvSource } {
  const max = opts?.max
  const withinMax = (n: number): boolean => max === undefined || n <= max
  const processVal = process.env[key]
  if (processVal !== undefined) {
    const n = parseInt(processVal, 10)
    if (Number.isFinite(n) && n > 0 && withinMax(n)) return { value: n, source: 'process' }
  }
  const fileVal = fileEnv[key]
  if (fileVal !== undefined) {
    const n = parseInt(fileVal, 10)
    if (Number.isFinite(n) && withinMax(n)) return { value: n, source: 'file' }
  }
  return { value: fallback, source: 'default' }
}

/** Resolve a string knob: process.env > file env > fallback. */
export function resolveStrEnv(
  key: string,
  fileEnv: Record<string, string | undefined>,
  fallback: string,
): { value: string; source: EnvSource } {
  const processVal = process.env[key]
  if (processVal !== undefined) return { value: processVal, source: 'process' }
  const fileVal = fileEnv[key]
  if (fileVal !== undefined) return { value: fileVal, source: 'file' }
  return { value: fallback, source: 'default' }
}

// ── Secrets: .env-file ONLY (AC-2, no process.env override path) ─────────────
export const TELEGRAM_BOT_TOKEN = env['TELEGRAM_BOT_TOKEN'] ?? ''
export const ALLOWED_CHAT_ID = env['ALLOWED_CHAT_ID'] ?? ''

export const SLACK_BOT_TOKEN = env['SLACK_BOT_TOKEN'] ?? ''
export const SLACK_APP_TOKEN = env['SLACK_APP_TOKEN'] ?? ''
export const SLACK_CHANNEL_ID = env['SLACK_CHANNEL_ID'] ?? ''

export const OWNER_NAME = env['OWNER_NAME'] ?? 'Szabolcs'
export const BOT_NAME = env['BOT_NAME'] ?? 'Marveen'

// Canonical identifier for the main agent in the DB, tmux sessions, plist
// labels, API routing, etc. The installer derives this from BOT_NAME
// (NFKD + ASCII + lowercase dashes). Older installs without this env var
// fall back to "marveen" so nothing breaks when upgrading in place.
export const MAIN_AGENT_ID = env['MAIN_AGENT_ID'] ?? 'marveen'

// ── Boot-network knobs: process.env > .env-file > default (AC-1) ─────────────
// max=65535: an out-of-range WEB_PORT (e.g. 99999) is rejected here and falls
// through to the .env/default instead of failing later at server.listen().
const webPortResult = resolveIntEnv('WEB_PORT', env, 3420, { max: 65535 })
export const WEB_PORT = webPortResult.value
// AC-1b tripwire: warn when process.env wins so a stray `tmux set-environment -g
// WEB_PORT` or supervisor edit is visible in dashboard.log immediately on boot.
if (webPortResult.source === 'process') {
  logger.warn({ key: 'WEB_PORT', source: 'process.env', port: WEB_PORT },
    'Boot knob WEB_PORT sourced from process environment (AC-1b tripwire) -- verify this is intentional')
}

const webHostResult = resolveStrEnv('WEB_HOST', env, '127.0.0.1')
export const WEB_HOST = webHostResult.value
if (webHostResult.source === 'process') {
  logger.warn({ key: 'WEB_HOST', source: 'process.env', host: WEB_HOST },
    'Boot knob WEB_HOST sourced from process environment (AC-1b tripwire) -- verify this is intentional')
}
export const DASHBOARD_PUBLIC_URL = env['DASHBOARD_PUBLIC_URL'] ?? ''
export const OLLAMA_URL = env['OLLAMA_URL'] ?? 'http://localhost:11434'

export const CHANNEL_PROVIDER: ChannelProviderType = getProviderType(env['CHANNEL_PROVIDER'])
export const CHANNEL_TOKEN = getChannelToken(CHANNEL_PROVIDER, env)
export const CHANNEL_CHAT_ID = getChannelChatId(CHANNEL_PROVIDER, env)

// Respawn / keep-alive gate.
// The in-process channel-plugin monitor (main-agent respawn + sub-agent
// auto-restart) must run on exactly ONE machine. When the same checkout runs
// on more than one host (e.g. a dev box alongside the production host), each
// would independently respawn agents and the two would fight over the same bot
// tokens / getUpdates slot. Gate it so only the intended host keeps agents alive.
//   RESPAWN_ENABLED -- "1"/"true" forces on, "0"/"false" forces off
//   RESPAWN_HOST    -- optional substring matched against the OS hostname; when
//                      set, respawn is enabled only on a host whose name matches
// Default (neither set): enabled, so a single-host install needs no config.
const RESPAWN_HOST = (env['RESPAWN_HOST'] ?? '').toLowerCase()
const RESPAWN_OVERRIDE = (env['RESPAWN_ENABLED'] ?? '').toLowerCase()
export const RESPAWN_ENABLED =
  RESPAWN_OVERRIDE === '1' || RESPAWN_OVERRIDE === 'true'
    ? true
    : RESPAWN_OVERRIDE === '0' || RESPAWN_OVERRIDE === 'false'
      ? false
      : RESPAWN_HOST
        ? hostname().toLowerCase().includes(RESPAWN_HOST)
        : true

// Heartbeat
export const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
export const HEARTBEAT_START_HOUR = 9
export const HEARTBEAT_END_HOUR = 23
export const HEARTBEAT_CALENDAR_ID = env['HEARTBEAT_CALENDAR_ID'] ?? ''
