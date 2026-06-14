import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  resolveAckCapableFromConfig,
  readAgentAckCapable,
  agentDir,
} from '../web/agent-config.js'

// Card 0978279f: a recipient is ACK-capable only when its agent-config.json
// explicitly opts in with `ackCapable: true`. FAIL-CLOSED: anything else (absent,
// false, a typo, a number, malformed file) -> not capable, so the ACK protocol
// stays inert until a recipient is deliberately flagged. Capability is read FRESH
// from the live config on every call (point d) -- a flag edit must take effect at
// router time, not require a dashboard restart.

describe('resolveAckCapableFromConfig (pure, fail-closed)', () => {
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

describe('readAgentAckCapable (fresh live-config read, point d)', () => {
  // A throwaway agent dir under the real AGENTS_BASE_DIR so agentDir/safeJoin
  // resolve it the same way the router will. Cleaned up after each test.
  const tmpName = `__ack_capable_test_${process.pid}`
  const tmpDir = agentDir(tmpName)
  const cfg = join(tmpDir, 'agent-config.json')

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reads ackCapable:true -> capable', () => {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(cfg, JSON.stringify({ ackCapable: true }))
    expect(readAgentAckCapable(tmpName)).toBe(true)
  })

  it('re-reads on every call (no boot-snapshot cache): true -> edit -> false', () => {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(cfg, JSON.stringify({ ackCapable: true }))
    expect(readAgentAckCapable(tmpName)).toBe(true)
    // Live edit (no restart) must flip the result immediately.
    writeFileSync(cfg, JSON.stringify({ ackCapable: false }))
    expect(readAgentAckCapable(tmpName)).toBe(false)
  })

  it('fail-closed on a missing config file', () => {
    expect(existsSync(cfg)).toBe(false)
    expect(readAgentAckCapable(tmpName)).toBe(false)
  })

  it('fail-closed on a malformed config (parse error)', () => {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(cfg, '{ this is not json')
    expect(readAgentAckCapable(tmpName)).toBe(false)
  })
})
