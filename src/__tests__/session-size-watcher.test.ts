import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  shouldCompactSession,
  shouldHardCompact,
  decideContextExhausted,
  adaptiveTokenThresholdForModel,
  adaptiveHardCeilingForModel,
  COMPACT_THRESHOLD_FRACTION,
  HARD_CEILING_FRACTION,
  DEFAULT_TOKEN_THRESHOLD,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_HARD_CEILING_TOKENS,
  CONTEXT_EXHAUSTED_ALERT_DEDUP_MS,
  type SessionSizeThresholds,
  type ContextExhaustionInput,
} from '../web/session-size-watcher.js'
import { DEFAULT_CONTEXT_WINDOW } from '../web/agent-config.js'

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
// Model-adaptive token threshold = contextWindow(model) * fraction
// ---------------------------------------------------------------------------

describe('adaptiveTokenThresholdForModel', () => {
  it('the compaction fraction is 0.75 (75% of the context window)', () => {
    expect(COMPACT_THRESHOLD_FRACTION).toBe(0.75)
  })

  it('Sonnet (200K window) -> 150K threshold', () => {
    expect(adaptiveTokenThresholdForModel('claude-sonnet-4-6')).toBe(150_000)
  })

  it('Haiku (200K window) -> 150K threshold', () => {
    expect(adaptiveTokenThresholdForModel('claude-haiku-4-5-20251001')).toBe(150_000)
  })

  it('Opus 1M (opus-4-8[1m]) -> 750K threshold', () => {
    expect(adaptiveTokenThresholdForModel('claude-opus-4-8[1m]')).toBe(750_000)
  })

  it('resolves model aliases too (opus -> 750K, sonnet -> 150K)', () => {
    expect(adaptiveTokenThresholdForModel('opus')).toBe(750_000)
    expect(adaptiveTokenThresholdForModel('sonnet')).toBe(150_000)
  })

  it('an unknown model falls back to the default window * fraction', () => {
    const expected = Math.floor(DEFAULT_CONTEXT_WINDOW * COMPACT_THRESHOLD_FRACTION)
    expect(adaptiveTokenThresholdForModel('some-future-model-x')).toBe(expected)
    expect(adaptiveTokenThresholdForModel(null)).toBe(expected)
    expect(adaptiveTokenThresholdForModel(undefined)).toBe(expected)
  })

  it('a 1M agent compacts much later than a 200K agent (the whole point)', () => {
    const sonnet = adaptiveTokenThresholdForModel('claude-sonnet-4-6')
    const opus = adaptiveTokenThresholdForModel('claude-opus-4-8[1m]')
    expect(opus).toBeGreaterThan(sonnet)
    // The 200K agent's threshold (150K) is below the legacy fixed 250K, so the
    // old constant would never have fired for it -- exactly the no-op bug fixed.
    expect(sonnet).toBeLessThan(DEFAULT_TOKEN_THRESHOLD)
  })

  it('feeds shouldCompactSession: a 200K agent fires at 150K, below the old 250K', () => {
    const thresholds: SessionSizeThresholds = {
      tokenThreshold: adaptiveTokenThresholdForModel('claude-sonnet-4-6'),
      cooldownMs: DEFAULT_COOLDOWN_MS,
    }
    expect(shouldCompactSession(149_999, null, NOW, thresholds)).toBe(false)
    expect(shouldCompactSession(150_000, null, NOW, thresholds)).toBe(true)
    // The old fixed 250K threshold would still be false here -- the regression.
    expect(160_000).toBeLessThan(DEFAULT_TOKEN_THRESHOLD)
  })

  it('feeds shouldCompactSession: a 1M agent only fires at 750K', () => {
    const thresholds: SessionSizeThresholds = {
      tokenThreshold: adaptiveTokenThresholdForModel('claude-opus-4-8[1m]'),
      cooldownMs: DEFAULT_COOLDOWN_MS,
    }
    expect(shouldCompactSession(749_999, null, NOW, thresholds)).toBe(false)
    expect(shouldCompactSession(750_000, null, NOW, thresholds)).toBe(true)
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
// Model-adaptive HARD ceiling = contextWindow(model) * 0.9, paired with the
// soft tier so the two never invert (the bug: a fixed 650K ceiling preempted
// the 750K soft trigger for opus-1M and was a dead no-op for 200K models).
// ---------------------------------------------------------------------------

describe('adaptiveHardCeilingForModel', () => {
  it('the hard fraction is 0.9 and sits strictly above the soft 0.75', () => {
    expect(HARD_CEILING_FRACTION).toBe(0.9)
    expect(HARD_CEILING_FRACTION).toBeGreaterThan(COMPACT_THRESHOLD_FRACTION)
  })

  it('Sonnet/Haiku (200K window) -> 180K hard ceiling', () => {
    expect(adaptiveHardCeilingForModel('claude-sonnet-4-6')).toBe(180_000)
    expect(adaptiveHardCeilingForModel('claude-haiku-4-5-20251001')).toBe(180_000)
  })

  it('Opus 1M (opus-4-8[1m]) -> 900K hard ceiling', () => {
    expect(adaptiveHardCeilingForModel('claude-opus-4-8[1m]')).toBe(900_000)
  })

  it('resolves aliases too (opus -> 900K, sonnet -> 180K)', () => {
    expect(adaptiveHardCeilingForModel('opus')).toBe(900_000)
    expect(adaptiveHardCeilingForModel('sonnet')).toBe(180_000)
  })

  it('an unknown / nullish model falls back to the default window * 0.9', () => {
    const expected = Math.floor(DEFAULT_CONTEXT_WINDOW * HARD_CEILING_FRACTION)
    expect(adaptiveHardCeilingForModel('some-future-model-x')).toBe(expected)
    expect(adaptiveHardCeilingForModel(null)).toBe(expected)
    expect(adaptiveHardCeilingForModel(undefined)).toBe(expected)
  })

  it('INVARIANT: for every model the hard ceiling is strictly above the soft threshold (no tier inversion)', () => {
    // This is the regression guard for the bug this change fixes: soft (idle-only)
    // must always trigger BEFORE hard (cooldown-bypassing), for every archetype.
    for (const model of [
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-8[1m]',
      'opus',
      'sonnet',
      'some-unknown-model',
      null,
      undefined,
    ]) {
      const soft = adaptiveTokenThresholdForModel(model)
      const hard = adaptiveHardCeilingForModel(model)
      expect(hard).toBeGreaterThan(soft)
    }
  })

  it('the 200K hard ceiling (180K) is now a LIVE trigger, not the dead fixed 650K no-op', () => {
    // The old fixed 650K ceiling could never fire for a 200K-window agent; the
    // adaptive 180K sits within reach and above its 150K soft trigger.
    const hard = adaptiveHardCeilingForModel('claude-sonnet-4-6')
    expect(hard).toBeLessThan(DEFAULT_HARD_CEILING_TOKENS)
    expect(shouldHardCompact(180_000, hard)).toBe(true)
    expect(shouldHardCompact(179_999, hard)).toBe(false)
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

  it('uses a per-model adaptive threshold (contextWindow * fraction), not a fixed constant', () => {
    // checkAgent must compute the threshold from the agent's model, so a 200K
    // agent gets a 150K threshold instead of the dead 250K no-op.
    const checkFn = SRC.slice(SRC.indexOf('function checkAgent('), SRC.indexOf('function checkAgentHardCeiling'))
    expect(checkFn).toMatch(/adaptiveTokenThresholdForModel\(/)
    expect(checkFn).toMatch(/resolveAgentModelId\(/)
  })

  it('the hard sweep also uses a per-model adaptive ceiling, not the fixed constant', () => {
    // checkAgentHardCeiling must derive the ceiling from the agent's model too,
    // so the hard tier is not a dead no-op for 200K models and never inverts the
    // soft tier for opus-1M. It must NOT pass the fixed DEFAULT_HARD_CEILING_TOKENS.
    const hardFn = SRC.slice(SRC.indexOf('function checkAgentHardCeiling'), SRC.indexOf('export function startSessionSizeWatcher'))
    expect(hardFn).toMatch(/adaptiveHardCeilingForModel\(/)
    expect(hardFn).toMatch(/resolveAgentModelId\(/)
    expect(hardFn).not.toMatch(/shouldHardCompact\(contextTokens, DEFAULT_HARD_CEILING_TOKENS\)/)
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

// ---------------------------------------------------------------------------
// Context-exhausted terminal-state decision (card b83e7c92 item-4)
//
// This signal sits on the LIVE escalation path, so it carries the mandatory
// adversarial-fixture set: a false-positive case, a false-negative case, and
// opposing combinations that must NOT fire. The detector must escalate the
// genuinely-wedged exhausted session WITHOUT alerting any recoverable or
// transient one.
// ---------------------------------------------------------------------------

describe('decideContextExhausted (terminal-state signal)', () => {
  const CEILING = 900_000 // ~1M window * 0.9
  const STUCK_MS = 30 * 60 * 1000

  function input(over: Partial<ContextExhaustionInput> = {}): ContextExhaustionInput {
    return {
      contextTokens: CEILING + 50_000, // over the ceiling by default
      hardCeiling: CEILING,
      paneIsIdle: false,
      overCeilingMs: STUCK_MS + 60_000, // past the stuck window by default
      ...over,
    }
  }

  // FALSE-NEGATIVE guard: the genuine terminal wedge MUST fire.
  it('fires for an agent over ceiling, never idle, stuck past the window', () => {
    expect(decideContextExhausted(input(), STUCK_MS)).toBe(true)
  })

  // FALSE-POSITIVE guard #1: an idle over-ceiling agent is RECOVERABLE
  // (the hard-ceiling /compact fires at the idle boundary) -- must NOT escalate.
  it('does NOT fire when the pane is idle (auto-/compact can recover it)', () => {
    expect(decideContextExhausted(input({ paneIsIdle: true }), STUCK_MS)).toBe(false)
  })

  // OPPOSING COMBINATION #1: over ceiling + not idle, but NOT yet stuck long
  // enough -- a transient mid-tool spike, not a terminal wedge -- must NOT fire.
  it('does NOT fire while still inside the stuck window (transient, not terminal)', () => {
    expect(decideContextExhausted(input({ overCeilingMs: STUCK_MS - 1 }), STUCK_MS)).toBe(false)
  })

  // OPPOSING COMBINATION #2: not a context problem at all -- under the ceiling,
  // even if not idle and "stuck" for ages (that is a different watcher's job).
  it('does NOT fire when under the hard ceiling regardless of stuck time', () => {
    expect(decideContextExhausted(
      input({ contextTokens: CEILING - 1, overCeilingMs: STUCK_MS * 10 }),
      STUCK_MS,
    )).toBe(false)
  })

  // FALSE-POSITIVE guard #2: unknown token count -- never escalate blind.
  it('does NOT fire when the token count is unreadable (null)', () => {
    expect(decideContextExhausted(input({ contextTokens: null }), STUCK_MS)).toBe(false)
  })

  // Boundary: exactly at the ceiling and exactly at the stuck window -> fires
  // (>= on both, mirroring shouldHardCompact's inclusive ceiling).
  it('fires exactly at the ceiling and exactly at the stuck boundary', () => {
    expect(decideContextExhausted(
      input({ contextTokens: CEILING, overCeilingMs: STUCK_MS }),
      STUCK_MS,
    )).toBe(true)
  })

  it('uses a 30-min escalation dedup, matching the channel-monitor cadence', () => {
    expect(CONTEXT_EXHAUSTED_ALERT_DEDUP_MS).toBe(30 * 60 * 1000)
  })
})
