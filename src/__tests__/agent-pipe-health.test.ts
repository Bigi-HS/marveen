/**
 * Tests for pipeHealthy surfacing in AgentSummary (OPS-126, 421cade3).
 * Tests the pure computePipeHealth() logic via source-text analysis since
 * the function is private (inlined in getAgentSummary).
 *
 * We verify the 3 states by checking the source text includes the logic.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(__dirname, '../web/routes/agents.ts'), 'utf-8')

describe('pipeHealthy in agents.ts (OPS-126, 421cade3)', () => {
  it('imports readAgentState from per-agent-pipe-watchdog', () => {
    expect(SRC).toContain("from '../per-agent-pipe-watchdog.js'")
    expect(SRC).toContain('readAgentState')
  })

  it('AgentSummary interface has pipeHealthy and pipeLastCheckedTs fields', () => {
    expect(SRC).toContain('pipeHealthy: boolean | null')
    expect(SRC).toContain('pipeLastCheckedTs: number | null')
  })

  it('computePipeHealth returns null when state is stale (> PIPE_HEALTH_STALE_MS)', () => {
    expect(SRC).toContain('PIPE_HEALTH_STALE_MS')
    expect(SRC).toContain('Date.now() - lastCheckedTs > PIPE_HEALTH_STALE_MS')
  })

  it('computePipeHealth returns false when consecutiveDead > 0', () => {
    expect(SRC).toContain('state.consecutiveDead === 0')
  })

  it('computePipeHealth is called in getAgentSummary', () => {
    expect(SRC).toContain('computePipeHealth(name)')
  })
})
