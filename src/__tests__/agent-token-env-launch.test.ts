import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Runtime contract tests for scripts/lib/agent-token-env.sh (card b1ce5118).
// The helper is SOURCED in every agent launch path to export GENESIS_AGENT_TOKEN
// from the agent's own 0600 token file. These tests actually run it under bash
// to pin: it exports a well-formed, unexpired token; it is a NO-OP (shared-bearer
// fallback) for a missing / symlinked / malformed / expired file; and it never
// leaks the token value to stdout/logs.

const HELPER = join(__dirname, '../../scripts/lib/agent-token-env.sh')
const TEST_ROOT = '/tmp/test-agent-token-env'
const VALID = 'a'.repeat(64) // 64-char hex shape
const FAR_FUTURE = '9999999999' // year 2286, never expired in any test run
const LONG_PAST = '1000' // 1970, always expired

// Source the helper under bash and report what it exported (stdout), its
// warnings (stderr), and its exit status -- the helper must never exit non-zero
// (a token problem is a no-op, never a launch failure).
function runHelper(env: Record<string, string>): { token: string; stderr: string; status: number | null } {
  const script = `. "${HELPER}"; printf '%s' "\${GENESIS_AGENT_TOKEN:-}"`
  const res = spawnSync('bash', ['-c', script], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf-8',
  })
  return { token: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status }
}

function writeToken(agent: string, token: string, expiry = ''): string {
  const dir = join(TEST_ROOT, 'agents', agent)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, '.genesis-token')
  writeFileSync(file, expiry ? `${token}\n${expiry}\n` : `${token}\n`, { mode: 0o600 })
  return file
}

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  mkdirSync(TEST_ROOT, { recursive: true })
})
afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe('agent-token-env.sh -- runtime behaviour', () => {
  it('exports a well-formed, non-expiring token', () => {
    writeToken('dave', VALID)
    const { token } = runHelper({ FLEET_ROOT: TEST_ROOT, GENESIS_AGENT_ID: 'dave' })
    expect(token).toBe(VALID)
  })

  it('exports a well-formed token whose expiry is in the future', () => {
    writeToken('dave', VALID, FAR_FUTURE)
    const { token } = runHelper({ FLEET_ROOT: TEST_ROOT, GENESIS_AGENT_ID: 'dave' })
    expect(token).toBe(VALID)
  })

  it('is a no-op (shared fallback) when the token has EXPIRED (Chad #3)', () => {
    writeToken('dave', VALID, LONG_PAST)
    const { token, stderr } = runHelper({ FLEET_ROOT: TEST_ROOT, GENESIS_AGENT_ID: 'dave' })
    expect(token).toBe('')
    expect(stderr).toMatch(/expired/)
    expect(stderr).not.toContain(VALID) // the warning must not leak the token
  })

  it('REFUSES a symlinked token file (Chad #4) -- the cross-agent privilege-theft vector', () => {
    // marveen holds the admin token; dave's token path is symlinked at it.
    const marveenFile = writeToken('marveen', 'b'.repeat(64))
    const daveDir = join(TEST_ROOT, 'agents', 'dave')
    mkdirSync(daveDir, { recursive: true })
    symlinkSync(marveenFile, join(daveDir, '.genesis-token'))
    const { token, stderr } = runHelper({ FLEET_ROOT: TEST_ROOT, GENESIS_AGENT_ID: 'dave' })
    expect(token).toBe('') // dave must NOT read marveen's admin token
    expect(stderr).toMatch(/symlink/)
    expect(stderr).not.toContain('b'.repeat(64))
  })

  it('is a no-op when the token is malformed (not 64-char hex)', () => {
    writeToken('dave', 'not-a-valid-token')
    const { token } = runHelper({ FLEET_ROOT: TEST_ROOT, GENESIS_AGENT_ID: 'dave' })
    expect(token).toBe('')
  })

  it('is a no-op when the token file is absent', () => {
    const { token } = runHelper({ FLEET_ROOT: TEST_ROOT, GENESIS_AGENT_ID: 'dave' })
    expect(token).toBe('')
  })

  it('is a no-op when GENESIS_AGENT_ID is unset', () => {
    writeToken('dave', VALID)
    const { token } = runHelper({ FLEET_ROOT: TEST_ROOT })
    expect(token).toBe('')
  })

  it('exits zero in every degraded case (a token problem never breaks a launch)', () => {
    expect(runHelper({ FLEET_ROOT: TEST_ROOT, GENESIS_AGENT_ID: 'ghost' }).status).toBe(0)
    expect(runHelper({ FLEET_ROOT: '/nonexistent', GENESIS_AGENT_ID: 'dave' }).status).toBe(0)
  })
})

describe('agent-token-env.sh -- never leaks the token value', () => {
  const SRC = readFileSync(HELPER, 'utf-8')

  it('the only thing it does with the token is export GENESIS_AGENT_TOKEN', () => {
    // No echo/printf/logger of the token local or the exported var.
    expect(SRC).not.toMatch(/echo[^\n]*\$_at_tok/)
    expect(SRC).not.toMatch(/echo[^\n]*\$GENESIS_AGENT_TOKEN/)
    expect(SRC).not.toMatch(/printf[^\n]*\$_at_tok/)
    expect(SRC).toMatch(/export GENESIS_AGENT_TOKEN="\$_at_tok"/)
  })

  it('clears all working locals at the end (no token residue in the shell env)', () => {
    expect(SRC).toMatch(/unset .*_at_tok/)
  })
})
