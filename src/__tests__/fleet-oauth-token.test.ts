import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readFleetOauthToken } from '../fleet-oauth-token.js'

// readFleetOauthToken is the TS counterpart of scripts/lib/fleet-oauth-env.sh:
// SDK-spawned launches (heartbeat worker) cannot source a shell helper, so they
// read the bare token here. These tests pin the safety contract -- strict parse
// (never `source`), shape validation, precedence -- and confirm the live read
// without ever surfacing the token VALUE (assertions reduce to booleans/labels).
const SRC = readFileSync(join(__dirname, '../fleet-oauth-token.ts'), 'utf-8')

describe('readFleetOauthToken -- safety contract', () => {
  it('strict-parses the env-file (single KEY=VALUE line), never sources/execs it', () => {
    expect(SRC).toMatch(/\^CLAUDE_CODE_OAUTH_TOKEN=\(\.\*\)\$/)
    expect(SRC).not.toMatch(/execSync|execFileSync|child_process/)
    // no shell `source` of the env-file
    expect(SRC).not.toMatch(/\.\s+["'`]\$\{?ENV_FILE/)
  })

  it('validates the token shape so a garbage value is treated as absent (null)', () => {
    expect(SRC).toMatch(/TOKEN_RE\s*=\s*\/\^sk-ant-/)
    expect(SRC).toMatch(/TOKEN_RE\.test\(/)
  })

  it('prefers the env-file over the raw token file (mirrors the bash helper precedence)', () => {
    const envIdx = SRC.indexOf('ENV_FILE')
    const rawIdx = SRC.indexOf('TOKEN_FILE')
    // both referenced, env-file branch appears first in the function body
    expect(envIdx).toBeGreaterThan(0)
    expect(rawIdx).toBeGreaterThan(0)
    const fnStart = SRC.indexOf('export function readFleetOauthToken')
    expect(SRC.indexOf('ENV_FILE', fnStart)).toBeLessThan(SRC.indexOf('TOKEN_FILE', fnStart))
  })

  it('never logs the token value (no logger import or call in the module)', () => {
    expect(SRC).not.toMatch(/logger/)
    expect(SRC).not.toMatch(/console\./)
  })
})

describe('readFleetOauthToken -- live read (value never surfaced)', () => {
  it('returns either null or a correctly-shaped bare bearer token', () => {
    const t = readFleetOauthToken()
    // Reduce to a boolean BEFORE the matcher so the token value can never be
    // printed in a failure diff.
    const ok = t === null || /^sk-ant-[A-Za-z0-9_-]{20,200}$/.test(t)
    expect(ok).toBe(true)
  })
})
