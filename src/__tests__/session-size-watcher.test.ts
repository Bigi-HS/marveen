import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  shouldCompactSession,
  shouldHardCompact,
  DEFAULT_TOKEN_THRESHOLD,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_HARD_CEILING_TOKENS,
  type SessionSizeThresholds,
} from '../web/session-size-watcher.js'

const THRESHOLDS: SessionSizeThresholds = {
  tokenThreshold: DEFAULT_TOKEN_THRESHOLD,
  cooldownMs: DEFAULT_COOLDOWN_MS,
}

const NOW = 1_700_000_000_000

// ---------------------------------------------------------------------------
// Pure shouldCompactSession decision
// ---------------------------------------------------------------------------

describe('shouldCompactSession', () => {
  it('returns false when transcript size is null (no prior session)', () => {
    expect(shouldCompactSession(null, null, NOW, THRESHOLDS)).toBe(false)
  })

  it('returns false when transcript is below the threshold', () => {
    expect(shouldCompactSession(DEFAULT_TOKEN_THRESHOLD - 1, null, NOW, THRESHOLDS)).toBe(false)
  })

  it('returns true when transcript meets the threshold and no prior compact', () => {
    expect(shouldCompactSession(DEFAULT_TOKEN_THRESHOLD, null, NOW, THRESHOLDS)).toBe(true)
  })

  it('returns true when transcript is over threshold and no prior compact', () => {
    expect(shouldCompactSession(DEFAULT_TOKEN_THRESHOLD * 2, null, NOW, THRESHOLDS)).toBe(true)
  })

  it('returns false when cooldown has not elapsed since last compact', () => {
    const lastCompact = NOW - DEFAULT_COOLDOWN_MS + 1000 // 1s inside cooldown
    expect(shouldCompactSession(DEFAULT_TOKEN_THRESHOLD * 2, lastCompact, NOW, THRESHOLDS)).toBe(false)
  })

  it('returns true when cooldown has elapsed since last compact', () => {
    const lastCompact = NOW - DEFAULT_COOLDOWN_MS - 1 // just past the cooldown
    expect(shouldCompactSession(DEFAULT_TOKEN_THRESHOLD * 2, lastCompact, NOW, THRESHOLDS)).toBe(true)
  })

  it('returns true when last compact was exactly at the threshold boundary', () => {
    const lastCompact = NOW - DEFAULT_COOLDOWN_MS // exactly at boundary
    expect(shouldCompactSession(DEFAULT_TOKEN_THRESHOLD * 2, lastCompact, NOW, THRESHOLDS)).toBe(true)
  })

  it('respects custom thresholds', () => {
    const custom: SessionSizeThresholds = { tokenThreshold: 500, cooldownMs: 60_000 }
    expect(shouldCompactSession(499, null, NOW, custom)).toBe(false)
    expect(shouldCompactSession(500, null, NOW, custom)).toBe(true)
    expect(shouldCompactSession(500, NOW - 30_000, NOW, custom)).toBe(false) // inside cooldown
    expect(shouldCompactSession(500, NOW - 60_000, NOW, custom)).toBe(true) // at boundary
  })

  it('treats zero-size transcript as below threshold (empty file)', () => {
    expect(shouldCompactSession(0, null, NOW, THRESHOLDS)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// shouldHardCompact -- the hard-ceiling tier (card 8a734a43)
// ---------------------------------------------------------------------------

describe('shouldHardCompact', () => {
  it('returns false when context is null', () => {
    expect(shouldHardCompact(null, DEFAULT_HARD_CEILING_TOKENS)).toBe(false)
  })

  it('returns false below the hard ceiling', () => {
    expect(shouldHardCompact(DEFAULT_HARD_CEILING_TOKENS - 1, DEFAULT_HARD_CEILING_TOKENS)).toBe(false)
  })

  it('returns true at and above the hard ceiling', () => {
    expect(shouldHardCompact(DEFAULT_HARD_CEILING_TOKENS, DEFAULT_HARD_CEILING_TOKENS)).toBe(true)
    expect(shouldHardCompact(DEFAULT_HARD_CEILING_TOKENS + 200_000, DEFAULT_HARD_CEILING_TOKENS)).toBe(true)
  })

  it('has NO cooldown term -- fires purely on the ceiling (cooldown bypass is intentional)', () => {
    // shouldHardCompact takes only (contextTokens, hardCeiling); recency cannot
    // suppress it. That is the whole point of the hard tier.
    expect(shouldHardCompact.length).toBe(2)
  })

  it('the default hard ceiling is well above the soft threshold', () => {
    expect(DEFAULT_HARD_CEILING_TOKENS).toBeGreaterThan(DEFAULT_TOKEN_THRESHOLD)
    expect(DEFAULT_HARD_CEILING_TOKENS).toBeGreaterThanOrEqual(600_000)
    expect(DEFAULT_HARD_CEILING_TOKENS).toBeLessThanOrEqual(700_000)
  })
})

// ---------------------------------------------------------------------------
// Source-contract tests: structural guarantees about the watcher
// ---------------------------------------------------------------------------

const SRC = readFileSync(join(__dirname, '../web/session-size-watcher.ts'), 'utf-8')

describe('session-size-watcher -- source contracts', () => {
  it('checks isReadyForPrompt before sending /compact', () => {
    expect(SRC).toMatch(/isReadyForPrompt\(pane\)/)
  })

  it('defers when pane is not idle (does not compact a busy agent)', () => {
    expect(SRC).toMatch(/!isReadyForPrompt\(pane\)/)
  })

  it('uses the most recently modified jsonl (not the largest)', () => {
    // The watcher must compare mtimeMs, not file size, when selecting the
    // active session transcript. After a /compact a NEW small file is created;
    // we must not keep re-compacting based on the old large file.
    expect(SRC).toMatch(/mtimeMs/)
    expect(SRC).toMatch(/latestMtime/)
  })

  it('clears cooldown on agent stop so a restarted agent is not penalised', () => {
    expect(SRC).toMatch(/lastCompactedAt\.delete\(name\)/)
  })

  it('triggers on context TOKENS (the cache_read driver), not transcript bytes', () => {
    expect(SRC).toMatch(/latestContextTokens/)
    expect(SRC).toMatch(/readContextTokensFromProjectDir/)
    expect(SRC).toMatch(/contextTokens/)
  })

  it('scopes to sub-agents only (does not target the main channels session)', () => {
    // The watcher iterates listAgentNames(), not the main channels session
    expect(SRC).toMatch(/listAgentNames\(\)/)
    // Should NOT reference MAIN_CHANNELS_SESSION
    expect(SRC).not.toMatch(/MAIN_CHANNELS_SESSION/)
  })

  it('encodes the agent dir path the same way startAgentProcess does', () => {
    // Both must use .replace(/\//g, '-') so the transcript dir resolves correctly
    expect(SRC).toMatch(/replace\(\/\\\/\/g, '-'\)/)
  })

  it('sends /compact as the compaction trigger', () => {
    expect(SRC).toMatch(/['"]\/compact['"]/)
  })

  it('exports startSessionSizeWatcher', () => {
    expect(SRC).toMatch(/export function startSessionSizeWatcher/)
  })
})

describe('session-size-watcher -- hard-ceiling tier contracts', () => {
  it('the hard-ceiling check ALSO gates on idle (never compacts a busy pane)', () => {
    // checkAgentHardCeiling must contain the same idle guard as the soft tier.
    const hardFn = SRC.slice(SRC.indexOf('function checkAgentHardCeiling'))
    expect(hardFn).toMatch(/!isReadyForPrompt\(pane\)/)
  })

  it('the hard tier bypasses the cooldown (no lastCompactedAt gate before sending)', () => {
    // shouldHardCompact has no cooldown parameter; the check sets lastCompactedAt
    // AFTER compacting (to inform the soft tier) but never reads it as a gate.
    const hardFn = SRC.slice(SRC.indexOf('function checkAgentHardCeiling'), SRC.indexOf('export function startSessionSizeWatcher'))
    expect(hardFn).toMatch(/shouldHardCompact/)
    expect(hardFn).not.toMatch(/lastCompactedAt\.get/)
  })

  it('runs a separate faster sweep than the 10-min soft sweep', () => {
    expect(SRC).toMatch(/HARD_CEILING_INTERVAL_MS/)
    expect(SRC).toMatch(/setInterval\(hardSweep, HARD_CEILING_INTERVAL_MS\)/)
  })

  it('makes the never-idle stuck-warning threshold env-configurable', () => {
    expect(SRC).toMatch(/process\.env\.SESSION_HARD_CEILING_STUCK_WARN_MS/)
  })

  it('does NOT send to a busy pane (no risky turn-boundary injection here)', () => {
    // The only sendPromptToSession in the hard path is guarded by the idle check
    // above; there is no "queue to busy pane" path.
    const hardFn = SRC.slice(SRC.indexOf('function checkAgentHardCeiling'), SRC.indexOf('export function startSessionSizeWatcher'))
    const sends = (hardFn.match(/sendPromptToSession/g) || []).length
    expect(sends).toBe(1)
  })
})
