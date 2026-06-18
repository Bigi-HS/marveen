import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Contract tests for the dashboard-launch wiring of the per-agent token (card
// b1ce5118). startAgentProcess provisions the agent's token file and sources
// scripts/lib/agent-token-env.sh in the launch command so the spawned shell
// carries GENESIS_AGENT_TOKEN. These pin that contract without booting tmux,
// mirroring fleet-oauth-launch.test.ts.
const PROCESS_SRC = readFileSync(join(__dirname, '../web/agent-process.ts'), 'utf-8')

describe('startAgentProcess -- per-agent token injection', () => {
  it('references the canonical agent-token helper path', () => {
    expect(PROCESS_SRC).toMatch(/AGENT_TOKEN_HELPER\s*=\s*join\(PROJECT_ROOT,\s*'scripts',\s*'lib',\s*'agent-token-env\.sh'\)/)
  })

  it('provisions the agent token best-effort (a failure must not break the launch)', () => {
    const idx = PROCESS_SRC.indexOf('provisionAgentToken(')
    expect(idx).toBeGreaterThan(0)
    // The provisioning call is wrapped in try/catch so a DB/disk error degrades
    // to the shared bearer rather than throwing out of the launch path.
    const before = PROCESS_SRC.slice(Math.max(0, idx - 60), idx)
    expect(before).toMatch(/try\s*{/)
    expect(PROCESS_SRC).toMatch(/provisioning failed; agent will use the shared bearer/)
  })

  it('writes the token to the agent\'s own 0600 file path', () => {
    expect(PROCESS_SRC).toMatch(/provisionAgentToken\(getDb\(\),\s*name,\s*join\(agentDir\(name\),\s*'\.genesis-token'\)\)/)
  })

  it('sources the helper with the agent id, guarded by existsSync (no-op when absent)', () => {
    const idx = PROCESS_SRC.indexOf('const agentTokenEnv =')
    expect(idx).toBeGreaterThan(0)
    const slice = PROCESS_SRC.slice(idx, idx + 220)
    expect(slice).toMatch(/existsSync\(AGENT_TOKEN_HELPER\)/)
    expect(slice).toMatch(/export GENESIS_AGENT_ID="\$\{name\}"/)
    expect(slice).toMatch(/\.\s+"\$\{AGENT_TOKEN_HELPER\}"/)
    expect(slice).toMatch(/:\s*''/)
  })

  it('wires agentTokenEnv into the launch command after the oauth env', () => {
    expect(PROCESS_SRC).toMatch(/\$\{fleetOauthEnv\}\$\{agentTokenEnv\}\$\{ollamaEnv\}/)
  })

  it('never logs the launch command or the token env segment (no token leak)', () => {
    expect(PROCESS_SRC).not.toMatch(/logger\.[a-z]+\([^)]*\bagentTokenEnv\b/)
    expect(PROCESS_SRC).not.toMatch(/logger\.[a-z]+\([^)]*GENESIS_AGENT_TOKEN/)
  })
})
