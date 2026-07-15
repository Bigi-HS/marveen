import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')

export function readEnvFile(keys?: string[]): Record<string, string> {
  const envPath = join(PROJECT_ROOT, '.env')
  let content: string
  try {
    content = readFileSync(envPath, 'utf-8')
  } catch {
    return {}
  }

  const result: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    let value = trimmed.slice(eqIdx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (keys && !keys.includes(key)) continue
    result[key] = value
  }
  return result
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Parses a single `NAME=value` entry out of raw .env content. The match is
// anchored to line start (multiline) so a prefixed var like MY_FOO= cannot
// satisfy a request for FOO=, and the value stops at the first whitespace or
// `#` so an inline comment is excluded. Pure (no I/O) so it is directly testable.
export function parseEnvValue(content: string, name: string): string | null {
  const re = new RegExp('^' + escapeRegExp(name) + '=([^#\\s]+)', 'm')
  const m = content.match(re)
  return m ? m[1].trim() : null
}

// File-backed convenience wrapper: reads the project .env and extracts one value.
// Shared by the loopback relay routes (notify bot token, github-search PAT) so the
// regex lives in one place.
export function readEnvValue(name: string): string | null {
  const envPath = join(PROJECT_ROOT, '.env')
  let content: string
  try {
    content = readFileSync(envPath, 'utf-8')
  } catch {
    return null
  }
  return parseEnvValue(content, name)
}
