import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  classifyAgentHealth,
  buildAgentHealth,
  HEALTH_ACTIVE_MS,
  HEALTH_STALL_MS,
  type AgentHealthFacts,
} from '../web/agent-health.js'

const NOW = 1_780_000_000_000 // fixed wall clock for deterministic ages

// A healthy, alive, quiet baseline. Each test overrides only the fields it
// exercises so the intent of every case is obvious.
function facts(overrides: Partial<AgentHealthFacts> = {}): AgentHealthFacts {
  return {
    name: 'dave',
    isMain: false,
    alive: true,
    lastProgressTs: NOW - 60_000, // a minute ago
    lastInboundTs: NOW - 90_000, // inbound before the turn -> answered
    lastRestartTs: NOW - 3_600_000,
    contextTokens: 12_345,
    channel: { provider: 'telegram', intentionallyEnabled: true, hasToken: true },
    tokenUsage: { totalCalls: 10, totalInput: 100, totalOutput: 20, totalCacheRead: 5, totalCacheCreation: 3 },
    ...overrides,
  }
}

describe('classifyAgentHealth', () => {
  it('is stopped whenever the session is not alive, ignoring all other signals', () => {
    expect(classifyAgentHealth(facts({ alive: false }), NOW)).toBe('stopped')
    // even a fresh inbound that would otherwise look stalled stays "stopped"
    expect(
      classifyAgentHealth(facts({ alive: false, lastInboundTs: NOW, lastProgressTs: NOW - HEALTH_STALL_MS * 2 }), NOW),
    ).toBe('stopped')
  })

  it('is stalled when an inbound is newer than the last turn by more than the stall window', () => {
    const f = facts({
      lastProgressTs: NOW - HEALTH_STALL_MS - 120_000,
      lastInboundTs: NOW - HEALTH_STALL_MS - 60_000, // inbound after the last turn, older than the window
    })
    expect(classifyAgentHealth(f, NOW)).toBe('stalled')
  })

  it('is stalled when inbound exists but the agent has never produced a turn', () => {
    const f = facts({ lastProgressTs: null, lastInboundTs: NOW - HEALTH_STALL_MS - 1 })
    expect(classifyAgentHealth(f, NOW)).toBe('stalled')
  })

  it('is NOT stalled when the fresh inbound is still inside the stall window (give it time to answer)', () => {
    const f = facts({ lastProgressTs: NOW - HEALTH_STALL_MS - 120_000, lastInboundTs: NOW - 1_000 })
    expect(classifyAgentHealth(f, NOW)).not.toBe('stalled')
  })

  it('is NOT stalled when the last turn is newer than the last inbound (already answered)', () => {
    const f = facts({ lastProgressTs: NOW - 1_000, lastInboundTs: NOW - HEALTH_STALL_MS * 3 })
    expect(classifyAgentHealth(f, NOW)).toBe('active')
  })

  it('is NOT stalled when there is no inbound at all, however old the last turn', () => {
    const f = facts({ lastInboundTs: null, lastProgressTs: NOW - HEALTH_STALL_MS * 5 })
    expect(classifyAgentHealth(f, NOW)).toBe('idle')
  })

  it('is active when a turn was produced within the active window', () => {
    expect(classifyAgentHealth(facts({ lastProgressTs: NOW - (HEALTH_ACTIVE_MS - 1_000) }), NOW)).toBe('active')
  })

  it('is idle when alive but the last turn predates the active window and nothing is pending', () => {
    const f = facts({ lastProgressTs: NOW - (HEALTH_ACTIVE_MS + 60_000), lastInboundTs: null })
    expect(classifyAgentHealth(f, NOW)).toBe('idle')
  })

  it('is idle when alive with no transcript yet (fresh boot, no progress, no inbound)', () => {
    expect(classifyAgentHealth(facts({ lastProgressTs: null, lastInboundTs: null }), NOW)).toBe('idle')
  })
})

describe('buildAgentHealth', () => {
  it('embeds the status and computes ages from the timestamps', () => {
    const h = buildAgentHealth(facts({ lastProgressTs: NOW - 60_000, lastInboundTs: NOW - 90_000 }), NOW)
    expect(h.status).toBe('active')
    expect(h.lastProgressAgeMs).toBe(60_000)
    expect(h.lastInboundAgeMs).toBe(90_000)
  })

  it('reports null ages when the corresponding timestamps are null', () => {
    const h = buildAgentHealth(facts({ lastProgressTs: null, lastInboundTs: null }), NOW)
    expect(h.lastProgressAgeMs).toBeNull()
    expect(h.lastInboundAgeMs).toBeNull()
  })

  it('passes the raw facts through unchanged (channel, token rollup, context)', () => {
    const f = facts()
    const h = buildAgentHealth(f, NOW)
    expect(h.channel).toEqual(f.channel)
    expect(h.tokenUsage).toEqual(f.tokenUsage)
    expect(h.contextTokens).toBe(f.contextTokens)
    expect(h.name).toBe('dave')
  })
})

// Source-contract: the literal /api/agents/health route MUST be matched before
// the /api/agents/:name param route, otherwise "health" is parsed as an agent
// name and the board 404s. This guards the ordering against future edits.
describe('agents route ordering', () => {
  const SRC = readFileSync(join(__dirname, '..', 'web', 'routes', 'agents.ts'), 'utf-8')

  it('registers GET /api/agents/health as a literal path', () => {
    expect(SRC).toContain("path === '/api/agents/health'")
  })

  it('places the health route before the /api/agents/:name param match', () => {
    const healthIdx = SRC.indexOf("path === '/api/agents/health'")
    const paramIdx = SRC.indexOf("path.match(/^\\/api\\/agents\\/([^/]+)$/)")
    expect(healthIdx).toBeGreaterThan(0)
    expect(paramIdx).toBeGreaterThan(0)
    expect(healthIdx).toBeLessThan(paramIdx)
  })
})
