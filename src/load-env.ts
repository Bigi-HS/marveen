// Dependency-free .env loader for the dashboard server entry (card 46b3bd75).
//
// WHY: the fleet-supervisor (re)launches the server with `exec node dist/index.js`
// and NO env block beyond PATH -- it does not source .env, and the app carried no
// dotenv. So a variable added to .env (e.g. NOA_DB_PATH for the noa.db cutover)
// never reached a respawned process, and getDb() silently fell back to
// store/claudeclaw.db. Loading .env from the app entry makes every launch path
// (supervisor respawn, manual run) get a consistent environment, regardless of the
// launcher.
//
// REAL ENV WINS: a key already present in process.env (set by the launcher /
// supervisor) is NEVER overwritten -- .env only fills gaps. Mirrors the Telegram
// plugin's loader. This module is PURE (no side effects); the boot wiring that
// reads the actual file lives in env-boot.ts so this stays unit-testable in
// isolation. Values are never logged -- only key NAMES are returned, so a caller
// can report a count/list without leaking a secret.

import { readFileSync } from 'node:fs'

// KEY must be a valid shell-style identifier; everything after the first `=` is
// the value (so `=` inside a value is preserved).
const LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value[0] === '"' && value[value.length - 1] === '"') ||
      (value[0] === "'" && value[value.length - 1] === "'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Apply `KEY=VALUE` lines from .env `content` to `env`, setting ONLY keys that are
 * not already defined (launcher / real env wins). Blank lines, comments (`#`), and
 * malformed lines are skipped; a matching pair of surrounding quotes on the value
 * is stripped. Returns the list of key NAMES that were set (never values).
 */
export function applyEnvContent(content: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const setKeys: string[] = []
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const m = LINE_RE.exec(line)
    if (m === null) continue
    const key = m[1]
    if (env[key] !== undefined) continue // real env wins -- do not overwrite
    env[key] = stripQuotes(m[2].trim())
    setKeys.push(key)
  }
  return setKeys
}

/**
 * Read and apply a .env file. A missing or unreadable file is a no-op (returns
 * `[]`) and never throws -- production may run with the env already fully provided
 * and no .env present. Returns the key NAMES that were set.
 */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): string[] {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return applyEnvContent(content, env)
}
