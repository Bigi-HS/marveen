/**
 * Tests for pendingPairingCount surfacing in AgentSummary (card 86e0c042).
 * Verifies the source structure via text analysis since countPendingPairings
 * is private. Uses the same pattern as agent-pipe-health.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(__dirname, '../web/routes/agents.ts'), 'utf-8')

describe('pendingPairingCount in agents.ts (card 86e0c042)', () => {
  it('AgentSummary interface has pendingPairingCount field', () => {
    expect(SRC).toContain('pendingPairingCount: number')
  })

  it('countPendingPairings helper is defined', () => {
    expect(SRC).toContain('function countPendingPairings(')
  })

  it('countPendingPairings filters expired pending entries', () => {
    expect(SRC).toContain('e.expiresAt > now')
  })

  it('countPendingPairings is called in getAgentSummary only when hasTelegram', () => {
    expect(SRC).toContain('tg.hasTelegram ? countPendingPairings(name) : 0')
  })

  it('countPendingPairings uses resolveAccessPath for telegram', () => {
    expect(SRC).toContain("resolveAccessPath(name, 'telegram')")
  })
})
