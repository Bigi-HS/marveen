import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  resolveAckCapableFromConfig,
  readAgentAckCapable,
  agentDir,
} from '../web/agent-config.js'
import { initDatabase, getDb } from '../db.js'
import { declareAck } from '../web/ack-registry.js'
import { MAIN_AGENT_ID } from '../config.js'

// V2 (card 83b7ec10): a recipient is ACK-capable iff it has a non-expired row in
// the runtime `agent_ack_registry` table. The static `ackCapable` config flag is
// NO LONGER consulted by the router path (AV2-AC1) -- that decoupling is the fix
// for the reverted V2's behavioral no-op. FAIL-CLOSED on every other path: no
// entry, expired entry, or DB error.
//
// `resolveAckCapableFromConfig` is retained (exported, Phase-2 cleanup) and still
// tested as a pure function, but it no longer drives readAgentAckCapable.

const TEST_DB = '/tmp/test-ack-capability.db'

function cleanDb() {
  for (const s of ['', '-wal', '-shm']) rmSync(TEST_DB + s, { force: true })
}

describe('resolveAckCapableFromConfig (pure, fail-closed -- retained for Phase 2)', () => {
  it('true only for boolean true', () => {
    expect(resolveAckCapableFromConfig({ ackCapable: true })).toBe(true)
  })

  it('accepts the string "true" (case-insensitive, trimmed) for hand-edits / form input', () => {
    expect(resolveAckCapableFromConfig({ ackCapable: 'true' })).toBe(true)
    expect(resolveAckCapableFromConfig({ ackCapable: '  TRUE  ' })).toBe(true)
  })

  it('fail-closed for absent / false / falsy / non-canonical values', () => {
    expect(resolveAckCapableFromConfig({})).toBe(false)
    expect(resolveAckCapableFromConfig({ ackCapable: false })).toBe(false)
    expect(resolveAckCapableFromConfig({ ackCapable: 'false' })).toBe(false)
    expect(resolveAckCapableFromConfig({ ackCapable: 0 })).toBe(false)
    expect(resolveAckCapableFromConfig({ ackCapable: 1 })).toBe(false)
    expect(resolveAckCapableFromConfig({ ackCapable: '1' })).toBe(false)
    expect(resolveAckCapableFromConfig({ ackCapable: 'yes' })).toBe(false)
    expect(resolveAckCapableFromConfig({ ackCapable: null })).toBe(false)
    expect(resolveAckCapableFromConfig({ ackCapable: undefined })).toBe(false)
  })
})

describe('readAgentAckCapable (V2 registry-authoritative)', () => {
  const NOW = Math.floor(Date.now() / 1000)
  // A throwaway agent dir so the static config can be written and then proven to
  // be IGNORED by the V2 router path. Cleaned up after each test.
  const tmpName = `__ack_capable_test_${process.pid}`
  const tmpDir = agentDir(tmpName)
  const cfg = join(tmpDir, 'agent-config.json')

  beforeEach(() => {
    cleanDb()
    initDatabase(TEST_DB)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('AV2-AC1: a static ackCapable:true in config is IGNORED without a registry entry', () => {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(cfg, JSON.stringify({ ackCapable: true }))
    // Static flag true, but no registry row -> fail-closed. The flag is ignored.
    expect(readAgentAckCapable(tmpName)).toBe(false)
  })

  it('a fresh registry declaration -> capable', () => {
    declareAck(getDb(), tmpName, 3600, NOW)
    expect(readAgentAckCapable(tmpName)).toBe(true)
  })

  it('an expired registry entry -> fail-closed', () => {
    // Declared 2h ago with a 1h ttl: expired.
    declareAck(getDb(), tmpName, 3600, NOW - 7200)
    expect(readAgentAckCapable(tmpName)).toBe(false)
  })

  it('fail-closed when no registry entry exists at all', () => {
    expect(readAgentAckCapable(tmpName)).toBe(false)
  })
})

describe('readAgentAckCapable -- MAIN_AGENT_ID special-case (AV2-AC9, card ff96810c)', () => {
  // The main agent (orchestrator) is ALWAYS ACK-capable, decided in CODE with no
  // agent-config.json and no registry entry. It is the central delegation hub and
  // the clear-observer already special-cases its pane (MAIN_AGENT_ID ->
  // MAIN_CHANNELS_SESSION). The hardcode is checked BEFORE any registry/db lookup,
  // so it holds even with no initialized database.
  beforeEach(() => {
    cleanDb()
    initDatabase(TEST_DB)
  })

  it('the main agent is capable in code, without any registry row', () => {
    expect(readAgentAckCapable(MAIN_AGENT_ID)).toBe(true)
  })

  it('does not blanket-enable a non-main unconfigured name', () => {
    expect(readAgentAckCapable(`__definitely_not_${process.pid}`)).toBe(false)
    expect(readAgentAckCapable(MAIN_AGENT_ID)).toBe(true)
  })
})
