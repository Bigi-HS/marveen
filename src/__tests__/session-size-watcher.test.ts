import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  shouldCompactSession,
  shouldHardCompact,
  shouldBusyCompact,
  decideContextExhausted,
  adaptiveTokenThresholdForModel,
  adaptiveHardCeilingForModel,
  adaptiveBusyCeilingForModel,
  COMPACT_THRESHOLD_FRACTION,
  HARD_CEILING_FRACTION,
  BUSY_COMPACT_FRACTION,
  BUSY_COMPACT_COOLDOWN_MS,
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
    const hardFn = SRC.slice(SRC.indexOf('function checkAgentHardCeiling'), SRC.indexOf('function checkAgentBusyCompact'))
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
    const hardFn = SRC.slice(SRC.indexOf('function checkAgentHardCeiling'), SRC.indexOf('function checkAgentBusyCompact'))
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

  it('the hard fn itself still only sends behind the idle check (busy injection lives elsewhere)', () => {
    // The hard-ceiling fn keeps its single idle-gated sendPromptToSession; the
    // turn-boundary (busy) injection is a SEPARATE function (checkAgentBusyCompact),
    // so the hard fn must still contain exactly one send, behind !isReadyForPrompt.
    const hardFn = SRC.slice(SRC.indexOf('function checkAgentHardCeiling'), SRC.indexOf('function checkAgentBusyCompact'))
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
      paneActivelyWorking: false, // wedged (neither idle nor working) by default
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

  // FALSE-POSITIVE guard #1b (card 1f0d92a7): an over-ceiling agent that is
  // ACTIVELY WORKING is RECOVERABLE -- the BUSY tier queues a /compact that runs
  // at the next turn boundary -- so it must NOT escalate, even if stuck for ages.
  it('does NOT fire when the pane is actively working (busy tier will queue /compact)', () => {
    expect(decideContextExhausted(
      input({ paneActivelyWorking: true, overCeilingMs: STUCK_MS * 10 }),
      STUCK_MS,
    )).toBe(false)
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

// ---------------------------------------------------------------------------
// BUSY tier (card 1f0d92a7): per-model busy ceiling = contextWindow * 0.78,
// strictly between the soft (0.75) trigger and the 80% alert wall.
// ---------------------------------------------------------------------------

describe('adaptiveBusyCeilingForModel', () => {
  it('the busy fraction is 0.78, between the soft 0.75 and the 80% wall', () => {
    expect(BUSY_COMPACT_FRACTION).toBe(0.78)
    expect(BUSY_COMPACT_FRACTION).toBeGreaterThan(COMPACT_THRESHOLD_FRACTION)
    expect(BUSY_COMPACT_FRACTION).toBeLessThan(0.8) // fires BEFORE the 80% alert wall
    expect(BUSY_COMPACT_FRACTION).toBeLessThan(HARD_CEILING_FRACTION)
  })

  it('Sonnet/Haiku (200K window) -> 156K busy ceiling', () => {
    expect(adaptiveBusyCeilingForModel('claude-sonnet-4-6')).toBe(156_000)
    expect(adaptiveBusyCeilingForModel('claude-haiku-4-5-20251001')).toBe(156_000)
  })

  it('Opus 1M (opus-4-8[1m]) -> 780K busy ceiling', () => {
    expect(adaptiveBusyCeilingForModel('claude-opus-4-8[1m]')).toBe(780_000)
  })

  it('resolves aliases too (opus -> 780K, sonnet -> 156K)', () => {
    expect(adaptiveBusyCeilingForModel('opus')).toBe(780_000)
    expect(adaptiveBusyCeilingForModel('sonnet')).toBe(156_000)
  })

  it('an unknown / nullish model falls back to the default window * 0.78', () => {
    const expected = Math.floor(DEFAULT_CONTEXT_WINDOW * BUSY_COMPACT_FRACTION)
    expect(adaptiveBusyCeilingForModel('some-future-model-x')).toBe(expected)
    expect(adaptiveBusyCeilingForModel(null)).toBe(expected)
    expect(adaptiveBusyCeilingForModel(undefined)).toBe(expected)
  })

  it('INVARIANT: for every model soft < busy < hard (no tier inversion)', () => {
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
      const busy = adaptiveBusyCeilingForModel(model)
      const hard = adaptiveHardCeilingForModel(model)
      expect(busy).toBeGreaterThan(soft)
      expect(hard).toBeGreaterThan(busy)
    }
  })
})

// ---------------------------------------------------------------------------
// shouldBusyCompact -- the pure BUSY-tier decision. It carries the SAFETY gate
// (only inject into an actively-working pane), so it gets the full adversarial
// fixture set: each guard proven in isolation.
// ---------------------------------------------------------------------------

describe('shouldBusyCompact', () => {
  const CEILING = 780_000 // ~1M window * 0.78
  const COOLDOWN = BUSY_COMPACT_COOLDOWN_MS

  it('the default busy cooldown is 45 minutes', () => {
    expect(BUSY_COMPACT_COOLDOWN_MS).toBe(45 * 60 * 1000)
  })

  // The positive case: over ceiling, actively working, cooldown elapsed.
  it('fires when over the busy ceiling, actively working, and past cooldown', () => {
    expect(shouldBusyCompact(CEILING, CEILING, true, null, NOW, COOLDOWN)).toBe(true)
    expect(shouldBusyCompact(CEILING + 50_000, CEILING, true, null, NOW, COOLDOWN)).toBe(true)
  })

  // SAFETY guard: NOT actively working -> never inject (idle/typing/unknown/
  // limit-menu panes are all paneActivelyWorking=false from the caller).
  it('does NOT fire when the pane is not actively working (the safety gate)', () => {
    expect(shouldBusyCompact(CEILING + 50_000, CEILING, false, null, NOW, COOLDOWN)).toBe(false)
  })

  it('does NOT fire below the busy ceiling even when actively working', () => {
    expect(shouldBusyCompact(CEILING - 1, CEILING, true, null, NOW, COOLDOWN)).toBe(false)
  })

  it('does NOT fire when the token count is unreadable (null)', () => {
    expect(shouldBusyCompact(null, CEILING, true, null, NOW, COOLDOWN)).toBe(false)
  })

  // Cooldown guard: prevents stacking a second queued /compact behind one that
  // has not yet fired at the turn boundary.
  it('does NOT fire inside the cooldown since the last compaction', () => {
    const lastCompact = NOW - COOLDOWN + 1000 // 1s inside the cooldown
    expect(shouldBusyCompact(CEILING + 50_000, CEILING, true, lastCompact, NOW, COOLDOWN)).toBe(false)
  })

  it('fires again once the cooldown has elapsed', () => {
    const lastCompact = NOW - COOLDOWN // exactly at the boundary
    expect(shouldBusyCompact(CEILING + 50_000, CEILING, true, lastCompact, NOW, COOLDOWN)).toBe(true)
  })

  it('is inclusive at the ceiling boundary (>=), mirroring the other tiers', () => {
    expect(shouldBusyCompact(CEILING, CEILING, true, null, NOW, COOLDOWN)).toBe(true)
    expect(shouldBusyCompact(CEILING - 1, CEILING, true, null, NOW, COOLDOWN)).toBe(false)
  })
})

describe('session-size-watcher -- busy-tier source contracts', () => {
  it('gates the busy injection on isActivelyWorking, NOT the coarse busy state', () => {
    // The safety key: queue /compact only into a live-spinner pane, so a
    // usage-limit menu / pending-paste pane (also "busy") is never injected into.
    const busyFn = SRC.slice(SRC.indexOf('function checkAgentBusyCompact'), SRC.indexOf('export function startSessionSizeWatcher'))
    expect(busyFn).toMatch(/isActivelyWorking\(pane\)/)
    expect(busyFn).toMatch(/shouldBusyCompact\(/)
  })

  it('the busy tier uses a per-model adaptive ceiling (not a fixed constant)', () => {
    const busyFn = SRC.slice(SRC.indexOf('function checkAgentBusyCompact'), SRC.indexOf('export function startSessionSizeWatcher'))
    expect(busyFn).toMatch(/adaptiveBusyCeilingForModel\(/)
    expect(busyFn).toMatch(/resolveAgentModelId\(/)
  })

  it('the busy tier respects the cooldown (reads lastCompactedAt before sending)', () => {
    // Unlike the hard tier, the busy tier MUST honor a cooldown so it does not
    // stack queued /compacts; it reads lastCompactedAt and passes it to the gate.
    const busyFn = SRC.slice(SRC.indexOf('function checkAgentBusyCompact'), SRC.indexOf('export function startSessionSizeWatcher'))
    expect(busyFn).toMatch(/lastCompactedAt\.get\(name\)/)
    expect(busyFn).toMatch(/BUSY_COMPACT_COOLDOWN_MS/)
  })

  it('the busy tier holds under a fleet pause (a /compact is a model call)', () => {
    const busyFn = SRC.slice(SRC.indexOf('function checkAgentBusyCompact'), SRC.indexOf('export function startSessionSizeWatcher'))
    expect(busyFn).toMatch(/shouldHoldProactiveWork\(`compact-busy:/)
  })

  it('the busy tier runs on the fast lane (called from hardSweep)', () => {
    const sweepFn = SRC.slice(SRC.indexOf('function hardSweep'), SRC.indexOf('setTimeout(sweep'))
    expect(sweepFn).toMatch(/checkAgentBusyCompact\(name\)/)
  })

  it('the busy cooldown is env-configurable for tuning without a rebuild', () => {
    expect(SRC).toMatch(/process\.env\.SESSION_BUSY_COMPACT_COOLDOWN_MS/)
  })

  it('stays sub-agents only -- never the main channels session (Boss 2026-06-17)', () => {
    // The busy tier rides the same listAgentNames() sweep; it must not introduce
    // any main-session target.
    expect(SRC).not.toMatch(/MAIN_AGENT_ID/)
    expect(SRC).not.toMatch(/marveen-channels/)
  })
})
