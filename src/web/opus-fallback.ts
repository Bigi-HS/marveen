// Opus weekly-cap auto-fallback (card 339d0a36).
//
// When an Opus-model agent hits the weekly usage cap (banner visible in the
// tmux pane), this module:
//   1. Detects the cap via pane content (reuses pane-state.ts signals).
//   2. Writes `claude-sonnet-4-6` to the agent's agent-config.json.
//   3. Kills the agent pane; the per-agent watchdog restarts it with the new
//      model automatically.
//   4. On Sunday >= 10:00 UTC (= 12:00 CEST, Anthropic weekly reset), restores
//      the original Opus model the same way.
//
// Only `dave` and `radar` run Opus routinely and are included in OPUS_FALLBACK_AGENTS;
// other agents already default to Sonnet and need no fallback logic.
//
// Per-agent state is persisted to store/.opus-fallback.json so a server restart
// does not lose track of which agents are in fallback and what their original
// model was.

import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { detectsUsageLimitMenu } from '../pane-state.js'

// Model identifier prefix that identifies Opus models.
const OPUS_ID_PREFIX = 'claude-opus'

// Additional CLI-level cap banners not covered by detectsUsageLimitMenu.
// "Usage credits required" appears when the agent type (opus-1M) has exhausted
// its credits allocation, distinct from the five-hour usage-limit menu.
const CREDITS_REQUIRED_RX = /usage credits required/i

// After a deactivate, suppress reactivation for this long so a stale pane
// that still shows the cap banner does not immediately re-trigger (card 4c800b62).
export const REACTIVATE_COOLDOWN_MS = 30 * 60 * 1000

// 5h-limit resets after ~5 hours. We use 6h (with buffer) as the time-based
// deactivation threshold. Sunday-noon restore only runs for weekly-cap activations.
export const FIVE_HOUR_LIMIT_RESET_MS = 6 * 60 * 60 * 1000

export const SONNET_FALLBACK = 'claude-sonnet-4-6'

// Agents that run Opus by default and therefore need automatic fallback logic.
// Other agents already run Sonnet and are excluded.
export const OPUS_FALLBACK_AGENTS: readonly string[] = ['dave', 'radar']

// Sunday Anthropic weekly reset = 10:00 UTC (= 12:00 CEST).
const SUNDAY_RESET_HOUR_UTC = 10

// Where per-agent fallback state is persisted.
export const FALLBACK_STATE_PATH = join(PROJECT_ROOT, 'store', '.opus-fallback.json')

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** True if the model ID refers to any Opus variant. */
export function isOpusModel(modelId: string): boolean {
  return modelId.startsWith(OPUS_ID_PREFIX)
}

/**
 * Returns the reason for the cap signal or null if no cap is detected.
 * Distinguishes 5h-limit (resets after ~5h) from weekly-cap (resets Sunday noon).
 * 5h-limit takes precedence when both signals are present (conservative).
 */
export function detectOpusCapReason(pane: string, nowMs?: number): CapReason | null {
  if (!pane) return null
  // nowMs ages out a STALE 5h-limit banner (reset already passed) so a leftover
  // footer cannot keep Opus pinned to the fallback model. card c7987f52.
  if (detectsUsageLimitMenu(pane, nowMs)) return '5h-limit'
  const tail = pane.split('\n').slice(-18).join('\n')
  if (CREDITS_REQUIRED_RX.test(tail)) return 'weekly-cap'
  return null
}

/**
 * True if the pane content signals a usage-limit / weekly-cap event.
 *
 * Two-tier: reuses the proven `detectsUsageLimitMenu` from pane-state.ts
 * (covers the five-hour limit menu) and adds the "Usage credits required"
 * banner (weekly Opus-cap CLI signal).
 */
export function detectOpusWeeklyCapInPane(pane: string, nowMs?: number): boolean {
  return detectOpusCapReason(pane, nowMs) !== null
}

/**
 * True if `nowMs` falls on a Sunday at or after 10:00 UTC.
 * Used to trigger the weekly Opus-model restore after Anthropic's reset.
 */
export function isSundayNoonUtc(nowMs: number): boolean {
  const d = new Date(nowMs)
  return d.getUTCDay() === 0 && d.getUTCHours() >= SUNDAY_RESET_HOUR_UTC
}

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

export type CapReason = 'weekly-cap' | '5h-limit'

export interface OpusFallbackState {
  fallbackActive: boolean
  /** The Opus model that was replaced; null when inactive. */
  originalModel: string | null
  /** Epoch ms when fallback was activated; null when inactive. */
  activeSince: number | null
  /** Epoch ms when fallback was last deactivated; used for reactivation cooldown. */
  deactivatedAt?: number | null
  /** Why the fallback was activated; absent = treat as 'weekly-cap' (backwards compat). */
  activationReason?: CapReason | null
}

export type OpusFallbackAction = 'activate' | 'deactivate' | 'none'

export interface OpusFallbackDecision {
  action: OpusFallbackAction
  /** Populated on `deactivate` so the caller knows which model to restore. */
  originalModel?: string
  reason: string
}

export interface DecideOpusFallbackOpts {
  paneHasCapSignal: boolean
  currentModel: string
  state: OpusFallbackState
  nowMs: number
}

/**
 * Pure decision: should we activate the Sonnet fallback, deactivate (restore
 * Opus after reset), or do nothing? (card 4c800b62 hardening)
 *
 * Priority: deactivate > activate.
 *
 * Deactivation paths:
 *   - weekly-cap (or unknown/absent reason): Sunday noon UTC restore.
 *   - 5h-limit: time-based restore after FIVE_HOUR_LIMIT_RESET_MS elapsed.
 *
 * Oscillation cooldown: after a deactivate, do NOT reactivate within
 * REACTIVATE_COOLDOWN_MS even if the pane still shows a stale cap banner.
 */
export function decideOpusFallback(opts: DecideOpusFallbackOpts): OpusFallbackDecision {
  const { paneHasCapSignal, currentModel, state, nowMs } = opts
  const reason = state.activationReason ?? 'weekly-cap' // absent = backwards-compat weekly-cap

  if (state.fallbackActive) {
    // 5h-limit: time-based deactivation (Sunday reset doesn't apply).
    if (reason === '5h-limit') {
      if (state.activeSince != null && nowMs - state.activeSince >= FIVE_HOUR_LIMIT_RESET_MS) {
        return {
          action: 'deactivate',
          originalModel: state.originalModel ?? undefined,
          reason: '5h-limit reset: restoring Opus after time-based expiry',
        }
      }
    } else {
      // weekly-cap: deactivate on Sunday noon UTC.
      if (isSundayNoonUtc(nowMs)) {
        return {
          action: 'deactivate',
          originalModel: state.originalModel ?? undefined,
          reason: 'Sunday weekly reset: restoring original Opus model',
        }
      }
    }
  }

  // Activate: cap signal in pane + agent is on Opus + not yet in fallback.
  if (paneHasCapSignal && isOpusModel(currentModel) && !state.fallbackActive) {
    // Oscillation cooldown: suppress reactivation shortly after a deactivate.
    const deactivatedAt = state.deactivatedAt ?? null
    if (deactivatedAt != null && nowMs - deactivatedAt < REACTIVATE_COOLDOWN_MS) {
      return { action: 'none', reason: 'reactivate cooldown active (post-deactivate)' }
    }
    return { action: 'activate', reason: 'Opus cap banner detected in pane' }
  }

  return { action: 'none', reason: 'no transition' }
}

// ---------------------------------------------------------------------------
// File-backed state (injectable for tests via direct module replacement)
// ---------------------------------------------------------------------------

export type FallbackStateMap = Record<string, OpusFallbackState>

export function readOpusFallbackState(path = FALLBACK_STATE_PATH): FallbackStateMap {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as FallbackStateMap
    }
  } catch {
    /* first run or missing file -> empty */
  }
  return {}
}

export function writeOpusFallbackState(state: FallbackStateMap, path = FALLBACK_STATE_PATH): void {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    atomicWriteFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 })
  } catch {
    /* best-effort: a missed write only causes a re-detect on the next tick */
  }
}
