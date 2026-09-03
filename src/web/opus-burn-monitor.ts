// Opus burn early-warning monitor (card 1584cad7).
//
// Aggregates weekly Opus token burn from token_usage (PR#182).
// Fires alerts before the weekly-cap pane-signal (C3) kicks in:
//   >70% of weekly limit -> warn to NoA (inter-agent, priority normal)
//   >90% of weekly limit -> urgent alert to NoA
//
// The "week" starts at Sunday 10:00 UTC, matching the opus-fallback Sunday reset
// (isSundayNoonUtc in opus-fallback.ts).
//
// token_usage.model stores suffix-dropped IDs (e.g. claude-opus-4-8, never
// claude-opus-4-8[1m]). Opus aggregation uses isOpusModel() (PREFIX match)
// so any Opus variant is counted regardless of suffix.
//
// Alert state is persisted to store/.opus-burn-alert.json so a server restart
// does not re-fire alerts that already went out this week.

import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { isOpusModel } from './opus-fallback.js'
import { getDb } from '../db.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Configurable weekly Opus token limit in megaTokens.
// Adjust once the exact Anthropic credit limit is confirmed.
export const OPUS_WEEKLY_LIMIT_MTOK = 200

// Sunday Anthropic weekly reset hour (UTC). Must match opus-fallback.ts.
const WEEKLY_RESET_HOUR_UTC = 10

// Where per-week alert deduplication state is persisted.
export const BURN_ALERT_STATE_PATH = join(PROJECT_ROOT, 'store', '.opus-burn-alert.json')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OpusBurnResult {
  weekStartMs: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheCreationTokens: number
  /** Combined burn = input + output + cacheCreation (cache_read excluded: free tier). */
  totalBurnTokens: number
  limitTokens: number
  /** Percentage 0-100+ of the weekly limit consumed. */
  burnPct: number
  thresholds: {
    pct70: boolean
    pct90: boolean
  }
  perAgent: Record<string, number>
}

export type BurnAlertLevel = 'warn70' | 'warn90'

export interface BurnAlertState {
  weekStartMs: number
  alerted70: boolean
  alerted90: boolean
}

export interface BurnAlert {
  level: BurnAlertLevel
  priority: 'normal' | 'urgent'
  message: string
  /** The new state to persist after firing this alert. */
  nextState: BurnAlertState
}

// ---------------------------------------------------------------------------
// Injectable deps (for unit testing without a live DB)
// ---------------------------------------------------------------------------

export interface BurnDeps {
  queryRows(weekStartSec: number): Array<{
    model: string
    agent: string
    input_tokens: number
    output_tokens: number
    cache_creation_tokens: number
  }>
}

export function defaultBurnDeps(): BurnDeps {
  return {
    queryRows(weekStartSec: number) {
      const db = getDb()
      return db.prepare(`
        SELECT agent, model, input_tokens, output_tokens, cache_creation_tokens
        FROM token_usage
        WHERE timestamp >= ? AND model IS NOT NULL
      `).all(weekStartSec) as Array<{
        model: string
        agent: string
        input_tokens: number
        output_tokens: number
        cache_creation_tokens: number
      }>
    },
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Returns the epoch-ms of the most recent Sunday 10:00 UTC at or before nowMs.
 * This is the start of the current Anthropic weekly Opus credit window.
 */
export function currentWeekStartMs(nowMs: number): number {
  const d = new Date(nowMs)
  // Milliseconds since the previous midnight Sunday UTC
  const daysSinceSunday = d.getUTCDay() // 0 = Sunday
  const msIntoDayUtc =
    d.getUTCHours() * 3_600_000 +
    d.getUTCMinutes() * 60_000 +
    d.getUTCSeconds() * 1_000 +
    d.getUTCMilliseconds()
  const sundayMidnightMs = nowMs - daysSinceSunday * 86_400_000 - msIntoDayUtc
  const sundayResetMs = sundayMidnightMs + WEEKLY_RESET_HOUR_UTC * 3_600_000

  // If the reset this Sunday hasn't fired yet, go back one full week
  return sundayResetMs <= nowMs ? sundayResetMs : sundayResetMs - 7 * 86_400_000
}

/**
 * Aggregate Opus token burn for the current week.
 * Uses PREFIX match (isOpusModel) so suffix-dropped model IDs are correctly caught.
 */
export function aggregateOpusBurn(
  nowMs: number,
  limitMtok: number = OPUS_WEEKLY_LIMIT_MTOK,
  deps: BurnDeps = defaultBurnDeps(),
): OpusBurnResult {
  const weekStartMs = currentWeekStartMs(nowMs)
  const weekStartSec = Math.floor(weekStartMs / 1000)

  const rows = deps.queryRows(weekStartSec)

  let input = 0, output = 0, cacheCreation = 0
  const perAgent: Record<string, number> = {}

  for (const row of rows) {
    if (!isOpusModel(row.model)) continue
    const burn = row.input_tokens + row.output_tokens + row.cache_creation_tokens
    input += row.input_tokens
    output += row.output_tokens
    cacheCreation += row.cache_creation_tokens
    perAgent[row.agent] = (perAgent[row.agent] ?? 0) + burn
  }

  const totalBurnTokens = input + output + cacheCreation
  const limitTokens = limitMtok * 1_000_000
  const burnPct = limitTokens > 0 ? (totalBurnTokens / limitTokens) * 100 : 0

  return {
    weekStartMs,
    totalInputTokens: input,
    totalOutputTokens: output,
    totalCacheCreationTokens: cacheCreation,
    totalBurnTokens,
    limitTokens,
    burnPct,
    thresholds: {
      pct70: burnPct >= 70,
      pct90: burnPct >= 90,
    },
    perAgent,
  }
}

/**
 * Pure decision: which alerts to fire, each carrying the nextState to persist.
 * Deduplicates per-week: once an alert fires, it won't repeat until the next week.
 */
export function decideBurnAlerts(
  result: OpusBurnResult,
  state: BurnAlertState,
): BurnAlert[] {
  const alerts: BurnAlert[] = []

  // New week: treat prior state as fresh (reset dedup flags conceptually)
  const weekChanged = state.weekStartMs !== result.weekStartMs
  const effective = weekChanged
    ? { weekStartMs: result.weekStartMs, alerted70: false, alerted90: false }
    : state

  const pctStr = result.burnPct.toFixed(1)
  const burnMtok = (result.totalBurnTokens / 1_000_000).toFixed(1)
  const limitMtok = (result.limitTokens / 1_000_000).toFixed(0)

  // 70% alert
  if (result.thresholds.pct70 && !effective.alerted70) {
    alerts.push({
      level: 'warn70',
      priority: 'normal',
      message:
        `[Opus burn 70%] Heti Opus-felhasznalasod elerte a ${pctStr}%-ot ` +
        `(${burnMtok}M / ${limitMtok}M token). Fontolja Sonnet-taskok atiranyitasat.`,
      nextState: { ...effective, alerted70: true },
    })
  }

  // 90% alert
  if (result.thresholds.pct90 && !effective.alerted90) {
    alerts.push({
      level: 'warn90',
      priority: 'urgent',
      message:
        `[Opus burn 90% URGENT] Heti Opus-keret kritikus: ${pctStr}% ` +
        `(${burnMtok}M / ${limitMtok}M token). Automatikus Sonnet-fallback koezel.`,
      nextState: { ...effective, alerted90: true },
    })
  }

  return alerts
}

// ---------------------------------------------------------------------------
// File-backed alert state
// ---------------------------------------------------------------------------

export function readBurnAlertState(path = BURN_ALERT_STATE_PATH): BurnAlertState {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const r = raw as Record<string, unknown>
      return {
        weekStartMs: typeof r['weekStartMs'] === 'number' ? r['weekStartMs'] : 0,
        alerted70: r['alerted70'] === true,
        alerted90: r['alerted90'] === true,
      }
    }
  } catch {
    /* first run or missing file */
  }
  return { weekStartMs: 0, alerted70: false, alerted90: false }
}

export function writeBurnAlertState(state: BurnAlertState, path = BURN_ALERT_STATE_PATH): void {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    atomicWriteFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 })
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Per-agent budget quiesce (card e6ab511d)
//
// The opus-burn-monitor (dashboard-server process) is the sole WRITER of the
// budget-pause marker. Watchdog and heartbeat/scheduled runners are readers
// only. This follows the measurer-writes principle: the monitor already has
// the token_usage query and per-agent burn data.
//
// Fail-safe: missing / unreadable / expired marker -> NOT paused. An agent is
// never silenced from uncertainty. Same principle as edc8b7f8 transport marker.
// ---------------------------------------------------------------------------

// Fleet-wide per-agent weekly budget default (MTok). Agents may override with
// budget.weeklyOutputMtok in their agent-config.json.
export const AGENT_WEEKLY_BUDGET_MTOK = 50

export interface BudgetPauseMarker {
  expiresAt: number
  weekStartMs: number
  triggeredAtPct: number
}

export interface AgentBudgetDecision {
  agentName: string
  burnTokens: number
  limitTokens: number
  burnPct: number
  shouldQuiesce: boolean
}

// Agent name slug validation: [a-z0-9-]+ only. Guards against path-traversal
// (e.g. '../other') when constructing the marker path. Agent names come from
// token_usage DB rows (server-controlled), but we validate defensively so a
// corrupt DB row cannot escape the store/ directory. Applied in
// budgetPauseMarkerPath so ALL callers (read + write) are covered.
const AGENT_SLUG_RE = /^[a-z0-9-]+$/

export function budgetPauseMarkerPath(agentName: string, storeDir = STORE_DIR): string {
  if (!AGENT_SLUG_RE.test(agentName)) throw new Error(`invalid agent slug: ${agentName}`)
  return join(storeDir, `.${agentName}-budget-pause`)
}

export function writeBudgetPauseMarker(agentName: string, nowMs: number, storeDir = STORE_DIR): void {
  // budgetPauseMarkerPath throws on invalid slug; catch -> fail-safe (no marker written).
  // Dashboard-server is sole caller -- export is intentional (30-min monitor only).
  const weekStartMs = currentWeekStartMs(nowMs)
  const expiresAt = weekStartMs + 7 * 24 * 3600 * 1000
  const marker: BudgetPauseMarker = { expiresAt, weekStartMs, triggeredAtPct: 0 }
  try {
    mkdirSync(storeDir, { recursive: true })
    atomicWriteFileSync(budgetPauseMarkerPath(agentName, storeDir), JSON.stringify(marker), { mode: 0o600 })
  } catch {
    /* best-effort: if write fails, no pause is written -- fail-safe direction */
  }
}

export function readBudgetPauseMarker(
  agentName: string,
  _nowMs: number,
  storeDir = STORE_DIR,
): BudgetPauseMarker | null {
  try {
    const raw = JSON.parse(readFileSync(budgetPauseMarkerPath(agentName, storeDir), 'utf-8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const r = raw as Record<string, unknown>
    if (typeof r['expiresAt'] !== 'number' || typeof r['weekStartMs'] !== 'number') return null
    return {
      expiresAt: r['expiresAt'],
      weekStartMs: r['weekStartMs'],
      triggeredAtPct: typeof r['triggeredAtPct'] === 'number' ? r['triggeredAtPct'] : 0,
    }
  } catch {
    return null // missing or corrupt -> fail-safe: no pause
  }
}

export function isBudgetPauseMarkerActive(agentName: string, nowMs: number, storeDir = STORE_DIR): boolean {
  const marker = readBudgetPauseMarker(agentName, nowMs, storeDir)
  if (!marker) return false
  // expiresAt is exclusive: marker is active only while nowMs < expiresAt
  return nowMs < marker.expiresAt
}

export function decideAgentQuiesce(
  perAgent: Record<string, number>,
  agentBudgetsMtok: Record<string, number>,
  _nowMs: number,
): AgentBudgetDecision[] {
  return Object.entries(perAgent).map(([agentName, burnTokens]) => {
    const limitMtok = agentBudgetsMtok[agentName] ?? AGENT_WEEKLY_BUDGET_MTOK
    const limitTokens = limitMtok * 1_000_000
    const burnPct = limitTokens > 0 ? (burnTokens / limitTokens) * 100 : 0
    return {
      agentName,
      burnTokens,
      limitTokens,
      burnPct,
      shouldQuiesce: burnTokens > limitTokens,
    }
  })
}
