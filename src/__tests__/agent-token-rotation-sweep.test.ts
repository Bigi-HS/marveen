import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  provisionAgentToken,
  sweepAgentTokenRotation,
  DEFAULT_AGENT_TOKEN_TTL_MS,
} from '../web/agent-token-provision.js'
import { migrateAgentTokenTable, resolveAgentIdentity } from '../web/agent-token-registry.js'

const SHARED = 'f'.repeat(64)
const NOW = 1_750_000_000_000
const TEST_DIR = '/tmp/test-agent-token-rotation-sweep'

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

function tokenFileFor(agentId: string): string {
  return join(TEST_DIR, 'agents', agentId, '.genesis-token')
}
function readTokenLine(agentId: string): string {
  return readFileSync(tokenFileFor(agentId), 'utf-8').split('\n')[0]
}

// Seed a token that expires `msFromNow` after NOW.
function seed(agentId: string, msFromNow: number): void {
  provisionAgentToken(db, agentId, tokenFileFor(agentId), {
    now: NOW - DEFAULT_AGENT_TOKEN_TTL_MS + msFromNow,
    ttlMs: DEFAULT_AGENT_TOKEN_TTL_MS,
  })
}

describe('sweepAgentTokenRotation (ENG-341d6d70 -- wire refreshTokenIfNeeded into a periodic sweep)', () => {
  it('rotates only agents whose token is expired or within the refresh threshold, leaving healthy ones untouched', () => {
    const oneHourMs = 60 * 60 * 1000
    seed('expired', -1) // already expired at NOW
    seed('near', oneHourMs) // within the 2h threshold
    seed('healthy', 10 * oneHourMs) // comfortable margin

    const before = {
      expired: readTokenLine('expired'),
      near: readTokenLine('near'),
      healthy: readTokenLine('healthy'),
    }

    const res = sweepAgentTokenRotation(db, {
      listAgents: () => ['expired', 'near', 'healthy'],
      tokenFileFor,
      now: NOW,
    })

    expect(res.checked).toBe(3)
    expect(res.refreshed.sort()).toEqual(['expired', 'near'])
    expect(res.errored).toEqual([])

    // Rotated tokens changed on disk and the new ones resolve; healthy is byte-identical.
    expect(readTokenLine('expired')).not.toBe(before.expired)
    expect(readTokenLine('near')).not.toBe(before.near)
    expect(readTokenLine('healthy')).toBe(before.healthy)
    expect(resolveAgentIdentity(db, readTokenLine('expired'), SHARED, NOW).kind).toBe('ok')
    expect(resolveAgentIdentity(db, readTokenLine('near'), SHARED, NOW).kind).toBe('ok')
  })

  it('no-ops agents that have never been launched (absent token file)', () => {
    seed('live', -1)
    const res = sweepAgentTokenRotation(db, {
      listAgents: () => ['live', 'ghost'],
      tokenFileFor,
      now: NOW,
    })
    expect(res.checked).toBe(2)
    expect(res.refreshed).toEqual(['live'])
    expect(res.errored).toEqual([])
  })

  it('isolates a failing agent and continues the sweep (one bad agent cannot starve the fleet)', () => {
    seed('good', -1) // expired -> will rotate fine

    // 'poison' has a readable, already-expired token (so rotation is attempted)
    // but its token dir is a symlink -> provisionAgentToken refuses to write
    // through it and throws. The token file lives in the victim dir so it is
    // reachable for reading through the symlink; only the WRITE trips the guard.
    const victimDir = join(TEST_DIR, 'victim')
    mkdirSync(victimDir, { recursive: true })
    writeFileSync(join(victimDir, '.genesis-token'), 'a'.repeat(64) + '\n1\n') // expiry epoch 1s = long expired
    mkdirSync(join(TEST_DIR, 'agents'), { recursive: true })
    symlinkSync(victimDir, join(TEST_DIR, 'agents', 'poison'))

    const errors: string[] = []
    const res = sweepAgentTokenRotation(db, {
      listAgents: () => ['good', 'poison'],
      tokenFileFor,
      now: NOW,
      onError: (agentId) => errors.push(agentId),
    })

    expect(res.checked).toBe(2)
    expect(res.refreshed).toEqual(['good'])
    expect(res.errored).toEqual(['poison'])
    expect(errors).toEqual(['poison'])
    // The good agent was rotated despite poison throwing.
    expect(resolveAgentIdentity(db, readTokenLine('good'), SHARED, NOW).kind).toBe('ok')
  })

  it('reports zero work when every token is healthy', () => {
    seed('a', 10 * 60 * 60 * 1000)
    seed('b', 20 * 60 * 60 * 1000)
    const res = sweepAgentTokenRotation(db, {
      listAgents: () => ['a', 'b'],
      tokenFileFor,
      now: NOW,
    })
    expect(res).toEqual({ checked: 2, refreshed: [], errored: [] })
  })

  it('honours a custom threshold (widening it rotates a token that the default would skip)', () => {
    const threeHoursMs = 3 * 60 * 60 * 1000
    seed('mid', threeHoursMs) // 3h out: outside the 2h default, inside a 4h threshold

    const defaultSweep = sweepAgentTokenRotation(db, {
      listAgents: () => ['mid'],
      tokenFileFor,
      now: NOW,
    })
    expect(defaultSweep.refreshed).toEqual([])

    const wideSweep = sweepAgentTokenRotation(db, {
      listAgents: () => ['mid'],
      tokenFileFor,
      now: NOW,
      thresholdMs: 4 * 60 * 60 * 1000,
    })
    expect(wideSweep.refreshed).toEqual(['mid'])
  })
})
