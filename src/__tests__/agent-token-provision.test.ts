import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdirSync, writeFileSync, rmSync, symlinkSync, statSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  provisionAgentToken,
  scopesForAgent,
  STANDARD_AGENT_SCOPES,
  DEFAULT_AGENT_TOKEN_TTL_MS,
} from '../web/agent-token-provision.js'
import { migrateAgentTokenTable, resolveAgentIdentity, ADMIN_SCOPE } from '../web/agent-token-registry.js'

const SHARED = 'f'.repeat(64)
const NOW = 1_750_000_000_000
const TEST_DIR = '/tmp/test-agent-token-provision'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  migrateAgentTokenTable(db)
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
})
afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

function readToken(file: string): { token: string; expiry: string } {
  const [token, expiry] = readFileSync(file, 'utf-8').split('\n')
  return { token, expiry }
}

describe('STANDARD_AGENT_SCOPES -- Chad capability matrix alignment (card e0afd7e9)', () => {
  it('uses messages:send (plural) not message:send -- matrix alignment gap 1', () => {
    expect(STANDARD_AGENT_SCOPES).toContain('messages:send')
    expect(STANDARD_AGENT_SCOPES).not.toContain('message:send')
  })
  it('includes memory:read so agents can read their own memories (gap 3)', () => {
    expect(STANDARD_AGENT_SCOPES).toContain('memory:read')
  })
  it('includes kanban:read + kanban:write + schedules:write for task management (gap 3, Q1)', () => {
    expect(STANDARD_AGENT_SCOPES).toContain('kanban:read')
    expect(STANDARD_AGENT_SCOPES).toContain('kanban:write')
    expect(STANDARD_AGENT_SCOPES).toContain('schedules:write')
  })
})

describe('scopesForAgent (design §5.3 assignment)', () => {
  it('marveen is the admin/operator', () => {
    expect(scopesForAgent('marveen')).toEqual([ADMIN_SCOPE])
  })
  it('applegate gets the curator cross-agent delete on top of the standard set', () => {
    expect(scopesForAgent('applegate')).toEqual([...STANDARD_AGENT_SCOPES, 'memory:delete:any'])
  })
  it('chad/thor get gate:approve on top of the standard set (gap 2 -- Chad audit)', () => {
    expect(scopesForAgent('chad')).toContain('gate:approve')
    expect(scopesForAgent('thor')).toContain('gate:approve')
    expect(scopesForAgent('chad')).toEqual(expect.arrayContaining([...STANDARD_AGENT_SCOPES]))
    expect(scopesForAgent('thor')).toEqual(expect.arrayContaining([...STANDARD_AGENT_SCOPES]))
  })
  it('dave gets gate:approve + gate:ci + agents:lifecycle (gaps 2, 4 -- Chad audit)', () => {
    const dave = scopesForAgent('dave')
    expect(dave).toEqual(expect.arrayContaining([...STANDARD_AGENT_SCOPES]))
    expect(dave).toContain('gate:approve')
    expect(dave).toContain('gate:ci')
    expect(dave).toContain('agents:lifecycle')
    expect(dave).not.toContain('memory:delete:any')
    expect(dave).not.toContain(ADMIN_SCOPE)
  })
  it('an unknown agent gets exactly the standard set (no elevated scopes)', () => {
    const scout = scopesForAgent('scout')
    expect(scout).toEqual([...STANDARD_AGENT_SCOPES])
    expect(scout).not.toContain('gate:approve')
    expect(scout).not.toContain('agents:lifecycle')
  })
})

describe('provisionAgentToken', () => {
  it('writes a 0600 two-line token file and registers the matching identity', () => {
    const file = join(TEST_DIR, 'agents', 'dave', '.genesis-token')
    const res = provisionAgentToken(db, 'dave', file, { now: NOW })

    // File: mode 0600, two lines (64-hex token + expiry seconds).
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const { token, expiry } = readToken(file)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(expiry).toBe(String(Math.floor((NOW + DEFAULT_AGENT_TOKEN_TTL_MS) / 1000)))

    // The registered sha matches the file's token, and resolving it returns the
    // correct identity + scopes.
    const r = resolveAgentIdentity(db, token, SHARED, NOW)
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(r.identity.agentId).toBe('dave')
    // dave's scopes include the standard set plus gate:approve/ci/lifecycle (Chad audit)
    expect(r.identity.scopes).toEqual(expect.arrayContaining([...STANDARD_AGENT_SCOPES]))
    expect(r.identity.scopes).toContain('gate:approve')
    expect(res.expiresAt).toBe(NOW + DEFAULT_AGENT_TOKEN_TTL_MS)
  })

  it('honours a custom ttl in the written expiry line', () => {
    const file = join(TEST_DIR, 'agents', 'thor', '.genesis-token')
    provisionAgentToken(db, 'thor', file, { now: NOW, ttlMs: 60_000 })
    expect(readToken(file).expiry).toBe(String(Math.floor((NOW + 60_000) / 1000)))
  })

  it('rotates: a second provision revokes the first token and only the new one resolves', () => {
    const file = join(TEST_DIR, 'agents', 'dave', '.genesis-token')
    provisionAgentToken(db, 'dave', file, { now: NOW })
    const first = readToken(file).token
    provisionAgentToken(db, 'dave', file, { now: NOW + 1000 })
    const second = readToken(file).token
    expect(second).not.toBe(first)
    // Old token is revoked -> unknown; new token resolves.
    expect(resolveAgentIdentity(db, first, SHARED, NOW + 1000).kind).toBe('unknown')
    expect(resolveAgentIdentity(db, second, SHARED, NOW + 1000).kind).toBe('ok')
  })

  it('write replaces a planted symlink rather than following it (Chad #4 write side)', () => {
    const outside = join(TEST_DIR, 'outside-secret')
    writeFileSync(outside, 'DO NOT CLOBBER')
    const dir = join(TEST_DIR, 'agents', 'dave')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, '.genesis-token')
    symlinkSync(outside, file) // attacker points the token path at an outside file

    provisionAgentToken(db, 'dave', file, { now: NOW })

    // The outside file is untouched; the token path is now a regular file.
    expect(readFileSync(outside, 'utf-8')).toBe('DO NOT CLOBBER')
    expect(lstatSync(file).isSymbolicLink()).toBe(false)
    expect(readToken(file).token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses to write through a symlinked PARENT directory rather than follow it (DA FLAG 1)', () => {
    // A peer's token dir, with its real token file already in place.
    const victimDir = join(TEST_DIR, 'agents', 'marveen')
    mkdirSync(victimDir, { recursive: true })
    const victimToken = join(victimDir, '.genesis-token')
    writeFileSync(victimToken, 'MARVEEN-ADMIN-TOKEN\n9999999999\n')

    // Attacker plants the agent's own dir as a symlink to the victim's dir
    // before its first launch: agents/dave -> agents/marveen.
    const attackerDir = join(TEST_DIR, 'agents', 'dave')
    symlinkSync(victimDir, attackerDir)
    const file = join(attackerDir, '.genesis-token')

    // Provisioning must throw, not follow the dir symlink and clobber the victim.
    expect(() => provisionAgentToken(db, 'dave', file, { now: NOW })).toThrow(/parent directory .* is a symlink/)

    // The victim's admin token file is untouched.
    expect(readFileSync(victimToken, 'utf-8')).toBe('MARVEEN-ADMIN-TOKEN\n9999999999\n')
  })
})
