import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// Contract tests for the dashboard-launch half of the fleet OAuth migration
// (PR #85 follow-up). The bash watchdogs source scripts/lib/fleet-oauth-env.sh
// at launch so every watchdog-launched agent carries CLAUDE_CODE_OAUTH_TOKEN
// (which overrides a stale .credentials.json). startAgentProcess is the OTHER
// launch path -- the dashboard restart button, the chameleon sandbox, and the
// scaffold -- which the bash migration could not reach. These assertions pin
// the contract that it now sources the SAME audited helper, additively, for
// shared-auth Claude agents only, and never logs the token value.
const PROCESS_SRC = readFileSync(join(__dirname, '../web/agent-process.ts'), 'utf-8')

describe('startAgentProcess -- fleet OAuth env injection (dashboard launch path)', () => {
  it('sources the canonical fleet-oauth-env.sh helper (single source of truth with the bash watchdogs)', () => {
    expect(PROCESS_SRC).toMatch(/FLEET_OAUTH_HELPER\s*=\s*join\(PROJECT_ROOT,\s*'scripts',\s*'lib',\s*'fleet-oauth-env\.sh'\)/)
    expect(PROCESS_SRC).toMatch(/\.\s+"\$\{FLEET_OAUTH_HELPER\}"/)
  })

  it('injects only for shared-auth Claude agents (own_team / api are excluded)', () => {
    expect(PROCESS_SRC).toMatch(/isClaude\s*&&\s*authMode === 'shared'\s*&&\s*existsSync\(FLEET_OAUTH_HELPER\)/)
  })

  it('is additive -- guarded by existsSync so it is a no-op when the helper is absent', () => {
    const idx = PROCESS_SRC.indexOf('const fleetOauthEnv =')
    expect(idx).toBeGreaterThan(0)
    const slice = PROCESS_SRC.slice(idx, idx + 220)
    expect(slice).toMatch(/existsSync\(FLEET_OAUTH_HELPER\)/)
    expect(slice).toMatch(/\?\s*`export FLEET_ROOT/)
    expect(slice).toMatch(/:\s*''/)
  })

  it('wires fleetOauthEnv into the launch command alongside the other env exports', () => {
    expect(PROCESS_SRC).toMatch(/\$\{claudeConfigEnv\}\$\{fleetOauthEnv\}\$\{ollamaEnv\}/)
  })

  it('exports the token via a SOURCED helper, not a value embedded in TS (token never in process memory or argv)', () => {
    // The helper exports CLAUDE_CODE_OAUTH_TOKEN inside the spawned shell; this
    // source must NOT read or assign the token value itself.
    expect(PROCESS_SRC).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN\s*=\s*[`'"]/)
    expect(PROCESS_SRC).not.toMatch(/readFileSync\([^)]*claude-oauth-token/)
  })

  it('never logs the launch command or the oauth env segment (no token leak)', () => {
    expect(PROCESS_SRC).not.toMatch(/logger\.[a-z]+\([^)]*\bcmd\b/)
    expect(PROCESS_SRC).not.toMatch(/logger\.[a-z]+\([^)]*fleetOauthEnv/)
  })
})

// Invariant guard for the silent-fallback bug class: an agent config that
// carries an authMode OUTSIDE VALID_AUTH_MODES (e.g. the legacy "oauth") is
// read by readAgentAuthMode as the default 'shared' -- the value is inert but
// MISLEADING (it reads as "this agent authenticates via OAuth" when the loader
// ignores it). The heartbeat agent shipped that exact "oauth" value; this
// pins that every committed agent config now uses a real, recognised mode so
// the misleading value cannot creep back in fleet-wide.
const VALID_AUTH_MODES = new Set(['shared', 'own_team', 'api'])
const AGENTS_DIR = join(__dirname, '../../agents')

describe('agent configs -- authMode invariant (no misleading silent-fallback values)', () => {
  const agentConfigs = existsSync(AGENTS_DIR)
    ? readdirSync(AGENTS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => ({ name: d.name, path: join(AGENTS_DIR, d.name, 'agent-config.json') }))
        .filter(c => existsSync(c.path))
    : []

  it('finds the committed agent configs to check', () => {
    // Guards against the glob silently matching nothing (which would make the
    // per-config assertions vacuously pass).
    expect(agentConfigs.length).toBeGreaterThan(0)
  })

  for (const { name, path } of agentConfigs) {
    it(`${name}: authMode, if set, is a recognised mode (not a silent-fallback value)`, () => {
      const cfg = JSON.parse(readFileSync(path, 'utf-8'))
      if (cfg.authMode !== undefined) {
        expect(VALID_AUTH_MODES.has(cfg.authMode)).toBe(true)
      }
    })
  }
})
