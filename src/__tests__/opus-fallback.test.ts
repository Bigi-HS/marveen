import { describe, it, expect } from 'vitest'
import {
  isOpusModel,
  detectOpusWeeklyCapInPane,
  detectOpusCapReason,
  decideOpusFallback,
  isSundayNoonUtc,
  SONNET_FALLBACK,
  OPUS_FALLBACK_AGENTS,
  REACTIVATE_COOLDOWN_MS,
  FIVE_HOUR_LIMIT_RESET_MS,
  type OpusFallbackState,
} from '../web/opus-fallback.js'

// ---------------------------------------------------------------------------
// isOpusModel
// ---------------------------------------------------------------------------
describe('isOpusModel', () => {
  it('returns true for known Opus model IDs', () => {
    expect(isOpusModel('claude-opus-4-8')).toBe(true)
    expect(isOpusModel('claude-opus-4-7')).toBe(true)
    expect(isOpusModel('claude-opus-4-6')).toBe(true)
    expect(isOpusModel('claude-opus-4-5')).toBe(true)
    expect(isOpusModel('claude-opus-4-8[1m]')).toBe(true)
  })

  it('returns false for Sonnet / Haiku / unknown', () => {
    expect(isOpusModel('claude-sonnet-4-6')).toBe(false)
    expect(isOpusModel('claude-haiku-4-5')).toBe(false)
    expect(isOpusModel('claude-sonnet-3-5')).toBe(false)
    expect(isOpusModel('')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// detectOpusWeeklyCapInPane
// ---------------------------------------------------------------------------
describe('detectOpusWeeklyCapInPane', () => {
  const limitMenuPane = [
    'Checking...',
    "You've reached your usage limit",
    'Stop and wait for limit to reset',
    '> ❯',
  ].join('\n')

  const limitPhrasePane = "Usage limit reached · resets at 5pm"

  const normalPane = [
    '> claude --continue',
    'Thinking...',
    '❯',
    '─────────────────────────────────────',
  ].join('\n')

  const prosePane = "the rate limit resets at 3am in most regions"

  it('detects usage-limit menu (strong signal)', () => {
    expect(detectOpusWeeklyCapInPane(limitMenuPane)).toBe(true)
  })

  it('detects usage-limit phrase + reset time (two-tier)', () => {
    expect(detectOpusWeeklyCapInPane(limitPhrasePane)).toBe(true)
  })

  it('returns false for a normal idle pane', () => {
    expect(detectOpusWeeklyCapInPane(normalPane)).toBe(false)
  })

  it('returns false for prose containing reset-time words only (no phrase)', () => {
    expect(detectOpusWeeklyCapInPane(prosePane)).toBe(false)
  })

  it('detects "Usage credits required" in the tail (weekly-cap CLI variant)', () => {
    expect(detectOpusWeeklyCapInPane('Usage credits required for 1M context')).toBe(true)
  })

  it('does NOT trigger on "usage credits required" buried deep in scrollback history (tail-anchor guard)', () => {
    // Chad FLAG [medium]: CREDITS_REQUIRED_RX must only test the tail (last 18 lines),
    // not the full pane. This is a document/error-description false-positive scenario.
    const scrollbackPane = [
      'Usage credits required for 1M context',  // line 1 -- in scrollback, >18 lines ago
      ...Array.from({ length: 20 }, (_, i) => `Normal output line ${i + 1}`),
      '❯',
      '─────────────────────────────────────',
    ].join('\n')
    expect(detectOpusWeeklyCapInPane(scrollbackPane)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isSundayNoonUtc
// ---------------------------------------------------------------------------
describe('isSundayNoonUtc', () => {
  // 2026-06-21 (Sunday) 10:00 UTC = 12:00 CEST
  const sundayNoon = Date.UTC(2026, 5, 21, 10, 0, 0)
  // 2026-06-21 09:59 UTC (just before)
  const sundayBefore = Date.UTC(2026, 5, 21, 9, 59, 0)
  // 2026-06-22 (Monday) 10:00 UTC
  const monday = Date.UTC(2026, 5, 22, 10, 0, 0)
  // 2026-06-20 (Saturday) 15:00 UTC
  const saturday = Date.UTC(2026, 5, 20, 15, 0, 0)

  it('returns true on Sunday at/after 10:00 UTC', () => {
    expect(isSundayNoonUtc(sundayNoon)).toBe(true)
    expect(isSundayNoonUtc(sundayNoon + 3600_000)).toBe(true) // 11:00 UTC Sunday
  })

  it('returns false on Sunday before 10:00 UTC', () => {
    expect(isSundayNoonUtc(sundayBefore)).toBe(false)
  })

  it('returns false on non-Sunday days', () => {
    expect(isSundayNoonUtc(monday)).toBe(false)
    expect(isSundayNoonUtc(saturday)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// decideOpusFallback
// ---------------------------------------------------------------------------
describe('decideOpusFallback', () => {
  const sundayNoonMs = Date.UTC(2026, 5, 21, 10, 0, 0)
  const saturdayMs = Date.UTC(2026, 5, 20, 15, 0, 0)

  const inactiveState: OpusFallbackState = { fallbackActive: false, originalModel: null, activeSince: null }
  const activeState: OpusFallbackState = { fallbackActive: true, originalModel: 'claude-opus-4-8', activeSince: saturdayMs - 3600_000 }

  it('activates when pane has cap signal AND agent runs Opus AND not yet active', () => {
    const d = decideOpusFallback({ paneHasCapSignal: true, currentModel: 'claude-opus-4-8', state: inactiveState, nowMs: saturdayMs })
    expect(d.action).toBe('activate')
  })

  it('does NOT activate if already active (dedupe)', () => {
    const d = decideOpusFallback({ paneHasCapSignal: true, currentModel: 'claude-opus-4-8', state: activeState, nowMs: saturdayMs })
    expect(d.action).toBe('none')
  })

  it('does NOT activate if current model is NOT Opus (already on Sonnet)', () => {
    const d = decideOpusFallback({ paneHasCapSignal: true, currentModel: 'claude-sonnet-4-6', state: inactiveState, nowMs: saturdayMs })
    expect(d.action).toBe('none')
  })

  it('does NOT activate without a cap signal', () => {
    const d = decideOpusFallback({ paneHasCapSignal: false, currentModel: 'claude-opus-4-8', state: inactiveState, nowMs: saturdayMs })
    expect(d.action).toBe('none')
  })

  it('deactivates on Sunday noon when fallback is active', () => {
    const d = decideOpusFallback({ paneHasCapSignal: false, currentModel: 'claude-sonnet-4-6', state: activeState, nowMs: sundayNoonMs })
    expect(d.action).toBe('deactivate')
  })

  it('deactivate provides the originalModel to restore', () => {
    const d = decideOpusFallback({ paneHasCapSignal: false, currentModel: 'claude-sonnet-4-6', state: activeState, nowMs: sundayNoonMs })
    expect(d.action).toBe('deactivate')
    expect(d.originalModel).toBe('claude-opus-4-8')
  })

  it('does NOT deactivate before Sunday noon even if active', () => {
    const d = decideOpusFallback({ paneHasCapSignal: false, currentModel: 'claude-sonnet-4-6', state: activeState, nowMs: saturdayMs })
    expect(d.action).toBe('none')
  })

  it('does NOT deactivate on Sunday noon if not active', () => {
    const d = decideOpusFallback({ paneHasCapSignal: false, currentModel: 'claude-opus-4-8', state: inactiveState, nowMs: sundayNoonMs })
    expect(d.action).toBe('none')
  })

  it('deactivate takes precedence over activate on Sunday noon (reset wins)', () => {
    // Edge: pane still shows cap signal on Sunday noon (agent is still wedged).
    // Deactivate should fire so the agent gets the Opus model restored.
    const d = decideOpusFallback({ paneHasCapSignal: true, currentModel: 'claude-sonnet-4-6', state: activeState, nowMs: sundayNoonMs })
    expect(d.action).toBe('deactivate')
  })
})

// ---------------------------------------------------------------------------
// detectOpusCapReason (card 4c800b62)
// ---------------------------------------------------------------------------
describe('detectOpusCapReason', () => {
  const limitMenuPane = [
    "You've reached your usage limit",
    'Stop and wait for limit to reset',
    '> ❯',
  ].join('\n')

  const creditsPane = 'Usage credits required for 1M context'

  it('returns "5h-limit" for the usage-limit menu', () => {
    expect(detectOpusCapReason(limitMenuPane)).toBe('5h-limit')
  })

  it('returns "weekly-cap" for the usage-credits-required banner', () => {
    expect(detectOpusCapReason(creditsPane)).toBe('weekly-cap')
  })

  it('returns null for a clean pane', () => {
    expect(detectOpusCapReason('❯')).toBeNull()
  })

  it('5h-limit takes precedence when both signals present (conservative)', () => {
    const both = [limitMenuPane, creditsPane].join('\n')
    expect(detectOpusCapReason(both)).toBe('5h-limit')
  })
})

// ---------------------------------------------------------------------------
// decideOpusFallback -- oscillation cooldown + 5h-vs-weekly (card 4c800b62)
// ---------------------------------------------------------------------------
describe('decideOpusFallback -- oscillation cooldown', () => {
  const saturdayMs = Date.UTC(2026, 5, 20, 15, 0, 0)

  it('does NOT activate if within the reactivate cooldown after deactivate', () => {
    const state: OpusFallbackState = {
      fallbackActive: false,
      originalModel: null,
      activeSince: null,
      deactivatedAt: saturdayMs - REACTIVATE_COOLDOWN_MS + 1, // just within cooldown
    }
    const d = decideOpusFallback({ paneHasCapSignal: true, currentModel: 'claude-opus-4-8', state, nowMs: saturdayMs })
    expect(d.action).toBe('none')
  })

  it('activates once the cooldown has elapsed after deactivate', () => {
    const state: OpusFallbackState = {
      fallbackActive: false,
      originalModel: null,
      activeSince: null,
      deactivatedAt: saturdayMs - REACTIVATE_COOLDOWN_MS - 1, // just past cooldown
    }
    const d = decideOpusFallback({ paneHasCapSignal: true, currentModel: 'claude-opus-4-8', state, nowMs: saturdayMs })
    expect(d.action).toBe('activate')
  })

  it('activates normally when deactivatedAt is null (no prior deactivate)', () => {
    const state: OpusFallbackState = { fallbackActive: false, originalModel: null, activeSince: null, deactivatedAt: null }
    const d = decideOpusFallback({ paneHasCapSignal: true, currentModel: 'claude-opus-4-8', state, nowMs: saturdayMs })
    expect(d.action).toBe('activate')
  })
})

describe('decideOpusFallback -- 5h-limit vs weekly-cap distinction', () => {
  const sundayNoonMs = Date.UTC(2026, 5, 21, 10, 0, 0)
  const saturdayMs = Date.UTC(2026, 5, 20, 15, 0, 0)

  it('does NOT deactivate on Sunday noon when activation was due to 5h-limit (within 6h window)', () => {
    // activeSince = just within FIVE_HOUR_LIMIT_RESET_MS so time-based reset hasn't fired
    const activeSince = sundayNoonMs - FIVE_HOUR_LIMIT_RESET_MS + 60_000
    const state: OpusFallbackState = {
      fallbackActive: true,
      originalModel: 'claude-opus-4-8',
      activeSince,
      activationReason: '5h-limit',
    }
    const d = decideOpusFallback({ paneHasCapSignal: false, currentModel: 'claude-sonnet-4-6', state, nowMs: sundayNoonMs })
    expect(d.action).toBe('none')
  })

  it('deactivates via 5h-limit time-based reset once FIVE_HOUR_LIMIT_RESET_MS elapsed', () => {
    const activeSince = saturdayMs - FIVE_HOUR_LIMIT_RESET_MS - 1
    const state: OpusFallbackState = {
      fallbackActive: true,
      originalModel: 'claude-opus-4-8',
      activeSince,
      activationReason: '5h-limit',
    }
    const d = decideOpusFallback({ paneHasCapSignal: false, currentModel: 'claude-sonnet-4-6', state, nowMs: saturdayMs })
    expect(d.action).toBe('deactivate')
  })

  it('does NOT deactivate 5h-limit activation before time-based reset expires', () => {
    const activeSince = saturdayMs - FIVE_HOUR_LIMIT_RESET_MS + 60_000 // 1 min short
    const state: OpusFallbackState = {
      fallbackActive: true,
      originalModel: 'claude-opus-4-8',
      activeSince,
      activationReason: '5h-limit',
    }
    const d = decideOpusFallback({ paneHasCapSignal: false, currentModel: 'claude-sonnet-4-6', state, nowMs: saturdayMs })
    expect(d.action).toBe('none')
  })

  it('deactivates on Sunday noon when activation was due to weekly-cap (existing path)', () => {
    const state: OpusFallbackState = {
      fallbackActive: true,
      originalModel: 'claude-opus-4-8',
      activeSince: saturdayMs,
      activationReason: 'weekly-cap',
    }
    const d = decideOpusFallback({ paneHasCapSignal: false, currentModel: 'claude-sonnet-4-6', state, nowMs: sundayNoonMs })
    expect(d.action).toBe('deactivate')
  })

  it('deactivates on Sunday noon when activationReason is absent (backwards compat = weekly-cap)', () => {
    const state: OpusFallbackState = {
      fallbackActive: true,
      originalModel: 'claude-opus-4-8',
      activeSince: saturdayMs,
      // no activationReason -> treat as weekly-cap
    }
    const d = decideOpusFallback({ paneHasCapSignal: false, currentModel: 'claude-sonnet-4-6', state, nowMs: sundayNoonMs })
    expect(d.action).toBe('deactivate')
  })
})

// ---------------------------------------------------------------------------
// Constants sanity
// ---------------------------------------------------------------------------
describe('constants', () => {
  it('SONNET_FALLBACK is the current Sonnet model', () => {
    expect(SONNET_FALLBACK).toBe('claude-sonnet-4-6')
  })

  it('OPUS_FALLBACK_AGENTS includes dave and radar', () => {
    expect(OPUS_FALLBACK_AGENTS).toContain('dave')
    expect(OPUS_FALLBACK_AGENTS).toContain('radar')
  })
})
