/**
 * Per-agent budget quiesce tests (card e6ab511d).
 *
 * Covers:
 *   - readBudgetPauseMarker: fail-safe (missing/unreadable/expired -> not active)
 *   - writeBudgetPauseMarker: writes expiry = next week rollover
 *   - decideAgentQuiesce: pure decision (under-budget = no pause, over-budget = pause)
 *   - expiry: marker older than its expiresAt -> not active
 *   - resume: rollover epoch -> marker expired -> agent un-quiesced
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  AGENT_WEEKLY_BUDGET_MTOK,
  OPUS_WEEKLY_LIMIT_MTOK,
  budgetPauseMarkerPath,
  writeBudgetPauseMarker,
  readBudgetPauseMarker,
  isBudgetPauseMarkerActive,
  decideAgentQuiesce,
  type AgentBudgetDecision,
} from '../web/opus-burn-monitor.js'

// ---------------------------------------------------------------------------
// Test store dir (isolated per-run tmp)
// ---------------------------------------------------------------------------
let storeDir: string

beforeEach(() => {
  storeDir = join(tmpdir(), `quiesce-test-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(storeDir, { recursive: true })
})

afterEach(() => {
  rmSync(storeDir, { recursive: true, force: true })
})

// Sunday 2026-06-21 10:00:00 UTC (Anthropic weekly reset anchor)
const SUN_RESET_UTC = Date.UTC(2026, 5, 21, 10, 0, 0)
const WEEK_MS = 7 * 24 * 3600 * 1000
const NOW = SUN_RESET_UTC + 2 * 3600_000 // Sunday 12:00 UTC

// ---------------------------------------------------------------------------
// budgetPauseMarkerPath
// ---------------------------------------------------------------------------
describe('budgetPauseMarkerPath', () => {
  it('returns path ending in .<agent>-budget-pause under store/', () => {
    const p = budgetPauseMarkerPath('dave', storeDir)
    expect(p).toMatch(/\.dave-budget-pause$/)
    expect(p).toContain(storeDir)
  })

  it('uses dotfile convention (leading dot)', () => {
    const p = budgetPauseMarkerPath('radar', storeDir)
    expect(p.split('/').at(-1)).toMatch(/^\./)
  })
})

// ---------------------------------------------------------------------------
// agentName slug validation (path-traversal guard)
// ---------------------------------------------------------------------------
describe('writeBudgetPauseMarker slug guard', () => {
  it('rejects path-traversal agentName (../escape)', () => {
    writeBudgetPauseMarker('../escape', NOW, storeDir)
    // budgetPauseMarkerPath itself throws on invalid slug -- verify via toThrow
    expect(() => budgetPauseMarkerPath('../escape', storeDir)).toThrow('invalid agent slug')
    // Also confirm no budget-pause file landed in the store dir
    expect(readdirSync(storeDir).some(f => f.includes('budget-pause'))).toBe(false)
  })

  it('rejects agentName with uppercase letters', () => {
    writeBudgetPauseMarker('Dave', NOW, storeDir)
    expect(() => budgetPauseMarkerPath('Dave', storeDir)).toThrow('invalid agent slug')
    expect(readdirSync(storeDir).some(f => f.includes('budget-pause'))).toBe(false)
  })

  it('rejects agentName with spaces', () => {
    writeBudgetPauseMarker('my agent', NOW, storeDir)
    expect(() => budgetPauseMarkerPath('my agent', storeDir)).toThrow('invalid agent slug')
    expect(readdirSync(storeDir).some(f => f.includes('budget-pause'))).toBe(false)
  })

  it('accepts valid lowercase-slug agentName', () => {
    writeBudgetPauseMarker('dave', NOW, storeDir)
    expect(isBudgetPauseMarkerActive('dave', NOW, storeDir)).toBe(true)
  })

  it('accepts agentName with hyphens and digits', () => {
    writeBudgetPauseMarker('agent-42', NOW, storeDir)
    expect(isBudgetPauseMarkerActive('agent-42', NOW, storeDir)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// writeBudgetPauseMarker / readBudgetPauseMarker
// ---------------------------------------------------------------------------
describe('writeBudgetPauseMarker', () => {
  it('writes a marker with expiresAt = next week rollover', () => {
    writeBudgetPauseMarker('dave', NOW, storeDir)
    const marker = readBudgetPauseMarker('dave', NOW, storeDir)
    expect(marker).not.toBeNull()
    // Expires at the start of the NEXT week
    expect(marker!.expiresAt).toBe(SUN_RESET_UTC + WEEK_MS)
  })

  it('includes weekStartMs in the marker', () => {
    writeBudgetPauseMarker('dave', NOW, storeDir)
    const marker = readBudgetPauseMarker('dave', NOW, storeDir)
    expect(marker!.weekStartMs).toBe(SUN_RESET_UTC)
  })
})

// ---------------------------------------------------------------------------
// readBudgetPauseMarker - fail-safe cases
// ---------------------------------------------------------------------------
describe('readBudgetPauseMarker (fail-safe)', () => {
  it('returns null when marker file does not exist (no pause)', () => {
    const result = readBudgetPauseMarker('nonexistent-agent', NOW, storeDir)
    expect(result).toBeNull()
  })

  it('returns null when marker file is corrupt JSON (fail-safe: no pause)', () => {
    const p = budgetPauseMarkerPath('corrupt-agent', storeDir)
    writeFileSync(p, 'NOT_JSON}}}')
    const result = readBudgetPauseMarker('corrupt-agent', NOW, storeDir)
    expect(result).toBeNull()
  })

  it('returns null when marker has no expiresAt field (fail-safe: no pause)', () => {
    const p = budgetPauseMarkerPath('badfield-agent', storeDir)
    writeFileSync(p, JSON.stringify({ weekStartMs: NOW })) // missing expiresAt
    const result = readBudgetPauseMarker('badfield-agent', NOW, storeDir)
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// isBudgetPauseMarkerActive
// ---------------------------------------------------------------------------
describe('isBudgetPauseMarkerActive', () => {
  it('false when no marker exists (fail-safe)', () => {
    expect(isBudgetPauseMarkerActive('dave', NOW, storeDir)).toBe(false)
  })

  it('true immediately after writing marker', () => {
    writeBudgetPauseMarker('dave', NOW, storeDir)
    expect(isBudgetPauseMarkerActive('dave', NOW, storeDir)).toBe(true)
  })

  it('false when marker is expired (expiresAt in the past)', () => {
    writeBudgetPauseMarker('dave', NOW, storeDir)
    // Simulate time after the next rollover
    const afterRollover = SUN_RESET_UTC + WEEK_MS + 3600_000
    expect(isBudgetPauseMarkerActive('dave', afterRollover, storeDir)).toBe(false)
  })

  it('false when marker expiresAt is exactly now (boundary: expired)', () => {
    writeBudgetPauseMarker('dave', NOW, storeDir)
    const expiresAt = SUN_RESET_UTC + WEEK_MS
    expect(isBudgetPauseMarkerActive('dave', expiresAt, storeDir)).toBe(false)
  })

  it('true when marker expiresAt is one ms in the future (boundary: active)', () => {
    writeBudgetPauseMarker('dave', NOW, storeDir)
    const justBefore = SUN_RESET_UTC + WEEK_MS - 1
    expect(isBudgetPauseMarkerActive('dave', justBefore, storeDir)).toBe(true)
  })

  it('false on corrupt marker file (fail-safe: no pause)', () => {
    writeFileSync(budgetPauseMarkerPath('corrupt', storeDir), '{bad json}')
    expect(isBudgetPauseMarkerActive('corrupt', NOW, storeDir)).toBe(false)
  })

  it('rollover resume: marker from prev week is expired in new week', () => {
    // Write marker in week 1
    writeBudgetPauseMarker('dave', NOW, storeDir)
    // Now it is week 2: marker should be expired
    const week2 = SUN_RESET_UTC + WEEK_MS + 3600_000
    expect(isBudgetPauseMarkerActive('dave', week2, storeDir)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// decideAgentQuiesce (pure decision core)
// ---------------------------------------------------------------------------
describe('decideAgentQuiesce', () => {
  const makePerAgent = (agents: Record<string, number>) => agents

  it('returns no quiesce when all agents are under budget (false-positive guard)', () => {
    const perAgent = makePerAgent({ dave: 10_000_000 }) // 10M tokens, well under 50MTok default
    const decisions = decideAgentQuiesce(perAgent, {}, NOW)
    expect(decisions.filter(d => d.shouldQuiesce)).toHaveLength(0)
  })

  it('returns quiesce when agent exceeds fleet default budget (false-negative guard)', () => {
    const limitTokens = AGENT_WEEKLY_BUDGET_MTOK * 1_000_000
    const perAgent = makePerAgent({ dave: limitTokens + 1 }) // just over limit
    const decisions = decideAgentQuiesce(perAgent, {}, NOW)
    const daveDecision = decisions.find(d => d.agentName === 'dave')
    expect(daveDecision?.shouldQuiesce).toBe(true)
  })

  it('respects per-agent budget override from config', () => {
    const perAgent = makePerAgent({ dave: 5_000_000 }) // 5M tokens
    // Custom budget of 3 MTok -> 5M exceeds it
    const agentBudgets = { dave: 3 }
    const decisions = decideAgentQuiesce(perAgent, agentBudgets, NOW)
    const daveDecision = decisions.find(d => d.agentName === 'dave')
    expect(daveDecision?.shouldQuiesce).toBe(true)
  })

  it('does NOT quiesce when burn is exactly at budget limit (boundary: no pause at exact limit)', () => {
    const limitTokens = AGENT_WEEKLY_BUDGET_MTOK * 1_000_000
    const perAgent = makePerAgent({ dave: limitTokens })
    const decisions = decideAgentQuiesce(perAgent, {}, NOW)
    const daveDecision = decisions.find(d => d.agentName === 'dave')
    expect(daveDecision?.shouldQuiesce).toBe(false)
  })

  it('quiesces only the over-budget agent (multi-agent)', () => {
    const limitTokens = AGENT_WEEKLY_BUDGET_MTOK * 1_000_000
    const perAgent = makePerAgent({
      dave: limitTokens + 1,  // over
      radar: limitTokens / 2, // under
    })
    const decisions = decideAgentQuiesce(perAgent, {}, NOW)
    expect(decisions.find(d => d.agentName === 'dave')?.shouldQuiesce).toBe(true)
    expect(decisions.find(d => d.agentName === 'radar')?.shouldQuiesce).toBe(false)
  })

  it('returns burnPct in each decision', () => {
    const limitTokens = AGENT_WEEKLY_BUDGET_MTOK * 1_000_000
    const perAgent = makePerAgent({ dave: limitTokens * 1.5 })
    const decisions = decideAgentQuiesce(perAgent, {}, NOW)
    const d = decisions.find(d => d.agentName === 'dave')
    expect(d?.burnPct).toBeCloseTo(150, 0)
  })

  it('returns decision for every agent in perAgent map', () => {
    const perAgent = makePerAgent({ dave: 1_000, radar: 2_000, morgan: 3_000 })
    const decisions = decideAgentQuiesce(perAgent, {}, NOW)
    expect(decisions.map(d => d.agentName).sort()).toEqual(['dave', 'morgan', 'radar'])
  })
})

// ---------------------------------------------------------------------------
// AGENT_WEEKLY_BUDGET_MTOK constant
// ---------------------------------------------------------------------------
describe('AGENT_WEEKLY_BUDGET_MTOK', () => {
  it('is a positive number', () => {
    expect(AGENT_WEEKLY_BUDGET_MTOK).toBeGreaterThan(0)
  })

  it('is less than the fleet-wide OPUS_WEEKLY_LIMIT_MTOK (per-agent is smaller than fleet)', () => {
    expect(AGENT_WEEKLY_BUDGET_MTOK).toBeLessThan(OPUS_WEEKLY_LIMIT_MTOK)
  })
})
