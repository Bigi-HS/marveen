import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  shouldCompactSession,
  DEFAULT_SIZE_THRESHOLD_BYTES,
  DEFAULT_COOLDOWN_MS,
  type SessionSizeThresholds,
} from '../web/session-size-watcher.js'

const THRESHOLDS: SessionSizeThresholds = {
  sizeThresholdBytes: DEFAULT_SIZE_THRESHOLD_BYTES,
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
    expect(shouldCompactSession(DEFAULT_SIZE_THRESHOLD_BYTES - 1, null, NOW, THRESHOLDS)).toBe(false)
  })

  it('returns true when transcript meets the threshold and no prior compact', () => {
    expect(shouldCompactSession(DEFAULT_SIZE_THRESHOLD_BYTES, null, NOW, THRESHOLDS)).toBe(true)
  })

  it('returns true when transcript is over threshold and no prior compact', () => {
    expect(shouldCompactSession(DEFAULT_SIZE_THRESHOLD_BYTES * 2, null, NOW, THRESHOLDS)).toBe(true)
  })

  it('returns false when cooldown has not elapsed since last compact', () => {
    const lastCompact = NOW - DEFAULT_COOLDOWN_MS + 1000 // 1s inside cooldown
    expect(shouldCompactSession(DEFAULT_SIZE_THRESHOLD_BYTES * 2, lastCompact, NOW, THRESHOLDS)).toBe(false)
  })

  it('returns true when cooldown has elapsed since last compact', () => {
    const lastCompact = NOW - DEFAULT_COOLDOWN_MS - 1 // just past the cooldown
    expect(shouldCompactSession(DEFAULT_SIZE_THRESHOLD_BYTES * 2, lastCompact, NOW, THRESHOLDS)).toBe(true)
  })

  it('returns true when last compact was exactly at the threshold boundary', () => {
    const lastCompact = NOW - DEFAULT_COOLDOWN_MS // exactly at boundary
    expect(shouldCompactSession(DEFAULT_SIZE_THRESHOLD_BYTES * 2, lastCompact, NOW, THRESHOLDS)).toBe(true)
  })

  it('respects custom thresholds', () => {
    const custom: SessionSizeThresholds = { sizeThresholdBytes: 500, cooldownMs: 60_000 }
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

  it('logs the transcript size in MB when compacting', () => {
    expect(SRC).toMatch(/transcriptSizeMb/)
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
