import { describe, it, expect } from 'vitest'
import {
  currentWeekStartMs,
  aggregateOpusBurn,
  decideBurnAlerts,
  OPUS_WEEKLY_LIMIT_MTOK,
  type BurnDeps,
  type BurnAlertState,
} from '../web/opus-burn-monitor.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Sunday 2026-06-21 10:00:00 UTC (the known Anthropic reset time)
const SUN_RESET_UTC = Date.UTC(2026, 5, 21, 10, 0, 0) // June = month 5

// One week = 7 * 24 * 3600 * 1000 ms
const WEEK_MS = 7 * 24 * 3600 * 1000

function makeRows(
  overrides: Array<{
    model: string
    agent?: string
    input?: number
    output?: number
    cacheCreation?: number
    timestamp?: number
  }>,
  weekStartSec: number,
) {
  return overrides.map(r => ({
    model: r.model,
    agent: r.agent ?? 'dave',
    input_tokens: r.input ?? 0,
    output_tokens: r.output ?? 0,
    cache_creation_tokens: r.cacheCreation ?? 0,
    timestamp: r.timestamp ?? weekStartSec + 100,
  }))
}

function makeDeps(rows: ReturnType<typeof makeRows>): BurnDeps {
  return {
    queryRows: (_weekStartSec: number) => rows,
  }
}

// ---------------------------------------------------------------------------
// currentWeekStartMs
// ---------------------------------------------------------------------------
describe('currentWeekStartMs', () => {
  it('returns the same Sunday 10:00 UTC when called on Sunday after reset', () => {
    // Sunday 15:00 UTC -- well after the reset
    const now = SUN_RESET_UTC + 5 * 3600_000
    expect(currentWeekStartMs(now)).toBe(SUN_RESET_UTC)
  })

  it('returns the same Sunday 10:00 UTC when called exactly at reset', () => {
    expect(currentWeekStartMs(SUN_RESET_UTC)).toBe(SUN_RESET_UTC)
  })

  it('returns PREVIOUS Sunday 10:00 UTC when called before reset on Sunday', () => {
    // Sunday 09:59 UTC -- reset has NOT fired yet
    const now = SUN_RESET_UTC - 60_000
    expect(currentWeekStartMs(now)).toBe(SUN_RESET_UTC - WEEK_MS)
  })

  it('returns previous Sunday 10:00 UTC for Monday', () => {
    // Monday 12:00 UTC after the Sunday reset
    const monday = SUN_RESET_UTC + 26 * 3600_000
    expect(currentWeekStartMs(monday)).toBe(SUN_RESET_UTC)
  })

  it('returns previous Sunday 10:00 UTC for Saturday at end of week', () => {
    // Saturday 23:59 UTC, just before next reset
    const saturday = SUN_RESET_UTC + 6 * 24 * 3600_000 - 60_000
    expect(currentWeekStartMs(saturday)).toBe(SUN_RESET_UTC)
  })
})

// ---------------------------------------------------------------------------
// aggregateOpusBurn
// ---------------------------------------------------------------------------
describe('aggregateOpusBurn', () => {
  const NOW = SUN_RESET_UTC + 2 * 3600_000 // Sunday 12:00 UTC (2h after reset)
  const WEEK_START_SEC = Math.floor(SUN_RESET_UTC / 1000)

  it('counts only Opus-prefixed models (PREFIX match, not exact)', () => {
    const rows = makeRows([
      { model: 'claude-opus-4-8', input: 1_000_000 },
      { model: 'claude-sonnet-4-6', input: 999_000_000 },
      { model: 'claude-haiku-4-5-20251001', input: 999_000_000 },
    ], WEEK_START_SEC)
    const result = aggregateOpusBurn(NOW, 200, makeDeps(rows))
    expect(result.totalInputTokens).toBe(1_000_000)
    expect(result.totalOutputTokens).toBe(0)
  })

  it('handles hypothetical future opus model names via PREFIX match', () => {
    // If a new model like claude-opus-5-0 arrives, it must still be counted
    const rows = makeRows([
      { model: 'claude-opus-5-0', input: 1_000_000 },
      { model: 'claude-opus-4-8', output: 500_000 },
    ], WEEK_START_SEC)
    const result = aggregateOpusBurn(NOW, 200, makeDeps(rows))
    expect(result.totalBurnTokens).toBe(1_500_000)
  })

  it('sums input + output + cacheCreation as burn tokens', () => {
    const rows = makeRows([
      { model: 'claude-opus-4-8', input: 1_000, output: 2_000, cacheCreation: 3_000 },
    ], WEEK_START_SEC)
    const result = aggregateOpusBurn(NOW, 200, makeDeps(rows))
    expect(result.totalBurnTokens).toBe(6_000)
    expect(result.totalInputTokens).toBe(1_000)
    expect(result.totalOutputTokens).toBe(2_000)
    expect(result.totalCacheCreationTokens).toBe(3_000)
  })

  it('does NOT count cache_read_tokens (they do not consume credits)', () => {
    // BurnDeps.queryRows only returns input/output/cacheCreation -- cache_read excluded
    const rows = makeRows([
      { model: 'claude-opus-4-8', input: 1_000 },
    ], WEEK_START_SEC)
    const result = aggregateOpusBurn(NOW, 200, makeDeps(rows))
    // totalBurnTokens = input + output + cacheCreation only
    expect(result.totalBurnTokens).toBe(1_000)
  })

  it('aggregates per-agent correctly', () => {
    const rows = [
      ...makeRows([{ model: 'claude-opus-4-8', input: 10_000 }], WEEK_START_SEC).map(r => ({ ...r, agent: 'dave' })),
      ...makeRows([{ model: 'claude-opus-4-8', output: 5_000 }], WEEK_START_SEC).map(r => ({ ...r, agent: 'radar' })),
    ]
    const result = aggregateOpusBurn(NOW, 200, makeDeps(rows))
    expect(result.perAgent['dave']).toBe(10_000)
    expect(result.perAgent['radar']).toBe(5_000)
  })

  it('returns 0 burn when no Opus rows', () => {
    const rows = makeRows([
      { model: 'claude-sonnet-4-6', input: 1_000_000 },
    ], WEEK_START_SEC)
    const result = aggregateOpusBurn(NOW, 200, makeDeps(rows))
    expect(result.totalBurnTokens).toBe(0)
    expect(result.burnPct).toBe(0)
  })

  it('returns 0 burn on empty input', () => {
    const result = aggregateOpusBurn(NOW, 200, makeDeps([]))
    expect(result.totalBurnTokens).toBe(0)
    expect(result.thresholds.pct70).toBe(false)
    expect(result.thresholds.pct90).toBe(false)
  })

  it('fires pct70 threshold at exactly 70%', () => {
    // 200 MTok limit * 0.70 = 140M tokens
    const LIMIT = 200
    const rows = makeRows([{ model: 'claude-opus-4-8', input: 140_000_000 }], WEEK_START_SEC)
    const result = aggregateOpusBurn(NOW, LIMIT, makeDeps(rows))
    expect(result.thresholds.pct70).toBe(true)
    expect(result.thresholds.pct90).toBe(false)
    expect(result.burnPct).toBeCloseTo(70, 5)
  })

  it('fires pct90 threshold at exactly 90%', () => {
    const LIMIT = 200
    const rows = makeRows([{ model: 'claude-opus-4-8', input: 180_000_000 }], WEEK_START_SEC)
    const result = aggregateOpusBurn(NOW, LIMIT, makeDeps(rows))
    expect(result.thresholds.pct70).toBe(true)
    expect(result.thresholds.pct90).toBe(true)
    expect(result.burnPct).toBeCloseTo(90, 5)
  })

  it('correctly computes weekStartMs from currentWeekStartMs(nowMs)', () => {
    const result = aggregateOpusBurn(NOW, 200, makeDeps([]))
    expect(result.weekStartMs).toBe(SUN_RESET_UTC)
  })

  it('limitTokens matches limitMtok * 1_000_000', () => {
    const result = aggregateOpusBurn(NOW, 150, makeDeps([]))
    expect(result.limitTokens).toBe(150_000_000)
  })

  it('OPUS_WEEKLY_LIMIT_MTOK is a positive number', () => {
    expect(OPUS_WEEKLY_LIMIT_MTOK).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// decideBurnAlerts
// ---------------------------------------------------------------------------
describe('decideBurnAlerts', () => {
  const WEEK_START = SUN_RESET_UTC

  const makeResult = (burnPct: number) => ({
    weekStartMs: WEEK_START,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalBurnTokens: Math.floor(burnPct * 2_000_000),
    limitTokens: 200_000_000,
    burnPct,
    thresholds: { pct70: burnPct >= 70, pct90: burnPct >= 90 },
    perAgent: {},
  })

  const freshState = (): BurnAlertState => ({
    weekStartMs: WEEK_START,
    alerted70: false,
    alerted90: false,
  })

  it('returns no alerts when burn < 70%', () => {
    const alerts = decideBurnAlerts(makeResult(50), freshState())
    expect(alerts).toHaveLength(0)
  })

  it('returns warn70 alert when burn crosses 70% for first time', () => {
    const alerts = decideBurnAlerts(makeResult(75), freshState())
    expect(alerts.some(a => a.level === 'warn70')).toBe(true)
  })

  it('does NOT re-alert at 70% if already alerted this week', () => {
    const state: BurnAlertState = { weekStartMs: WEEK_START, alerted70: true, alerted90: false }
    const alerts = decideBurnAlerts(makeResult(75), state)
    expect(alerts.some(a => a.level === 'warn70')).toBe(false)
  })

  it('returns warn90 alert when burn crosses 90% for first time', () => {
    const state: BurnAlertState = { weekStartMs: WEEK_START, alerted70: true, alerted90: false }
    const alerts = decideBurnAlerts(makeResult(92), state)
    expect(alerts.some(a => a.level === 'warn90')).toBe(true)
  })

  it('does NOT re-alert at 90% if already alerted this week', () => {
    const state: BurnAlertState = { weekStartMs: WEEK_START, alerted70: true, alerted90: true }
    const alerts = decideBurnAlerts(makeResult(95), state)
    expect(alerts).toHaveLength(0)
  })

  it('resets alerts for a new week (different weekStartMs)', () => {
    // State from LAST week -- alerted70 was true then
    const oldState: BurnAlertState = {
      weekStartMs: WEEK_START - WEEK_MS,
      alerted70: true,
      alerted90: false,
    }
    // This week's result at 75% -- should re-alert because week changed
    const alerts = decideBurnAlerts(makeResult(75), oldState)
    expect(alerts.some(a => a.level === 'warn70')).toBe(true)
  })

  it('alert includes burnPct in the message', () => {
    const alerts = decideBurnAlerts(makeResult(75), freshState())
    const warn70 = alerts.find(a => a.level === 'warn70')
    expect(warn70?.message).toMatch(/70|75/)
  })

  it('warn90 alert has higher priority than warn70', () => {
    const state: BurnAlertState = { weekStartMs: WEEK_START, alerted70: true, alerted90: false }
    const alerts = decideBurnAlerts(makeResult(92), state)
    const warn90 = alerts.find(a => a.level === 'warn90')
    expect(warn90?.priority).toBe('urgent')
    const warn70alerts = alerts.filter(a => a.level === 'warn70')
    const warn70 = warn70alerts[0]
    // warn70 should not appear (already alerted)
    expect(warn70).toBeUndefined()
  })

  it('returns both alerts when crossing 70% AND 90% in same fresh check', () => {
    // Edge: first check and already at 95% -- both should fire
    const alerts = decideBurnAlerts(makeResult(95), freshState())
    expect(alerts.some(a => a.level === 'warn70')).toBe(true)
    expect(alerts.some(a => a.level === 'warn90')).toBe(true)
  })

  it('alert nextState.alerted70 true after warn70 fires', () => {
    const alerts = decideBurnAlerts(makeResult(75), freshState())
    const warn70 = alerts.find(a => a.level === 'warn70')
    expect(warn70?.nextState.alerted70).toBe(true)
  })

  it('alert nextState.alerted90 true after warn90 fires', () => {
    const state: BurnAlertState = { weekStartMs: WEEK_START, alerted70: true, alerted90: false }
    const alerts = decideBurnAlerts(makeResult(92), state)
    const warn90 = alerts.find(a => a.level === 'warn90')
    expect(warn90?.nextState.alerted90).toBe(true)
  })
})
