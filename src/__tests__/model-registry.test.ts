import { describe, it, expect } from 'vitest'
import {
  MODEL_REGISTRY,
  MODEL_CONTEXT_WINDOWS,
  DEFAULT_CONTEXT_WINDOW,
  contextWindowForModel,
  modelInfoForModel,
  costForUsageUsd,
  isModelDeprecated,
  modelSupports1M,
} from '../web/agent-config.js'

// Card b83e7c92 item-1 (opencode quick-wins): promote the bare context-window
// map into one typed model registry that is the SINGLE SOURCE OF TRUTH for the
// per-model facts the fleet needs -- window (compact sizing), list price (the
// planned per-agent cost rollup, bb4992dc), deprecation date (stale-model
// warnings), and the 1M-context flag. The window accessor must keep its exact
// prior behavior; the new facts are exposed via small pure accessors.

describe('MODEL_REGISTRY (single source of truth)', () => {
  it('covers every model id that appears in a live agent-config', () => {
    // The two un-suffixed/un-dated ids the card flagged as silently falling to
    // the 200K default, plus the local Ollama model, must be explicit entries.
    for (const id of [
      'claude-opus-4-8[1m]',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
      'claude-haiku-4-5',
      'qwen3:4b',
    ]) {
      expect(MODEL_REGISTRY[id], `registry missing live model ${id}`).toBeTruthy()
    }
  })

  it('every entry is internally consistent (positive window, non-negative prices)', () => {
    for (const [id, info] of Object.entries(MODEL_REGISTRY)) {
      expect(info.window, `${id} window`).toBeGreaterThan(0)
      expect(info.inputPricePerMTok, `${id} input price`).toBeGreaterThanOrEqual(0)
      expect(info.outputPricePerMTok, `${id} output price`).toBeGreaterThanOrEqual(0)
      expect(typeof info.supports1M, `${id} supports1M`).toBe('boolean')
      expect(
        info.deprecationDate === null || /^\d{4}-\d{2}-\d{2}$/.test(info.deprecationDate),
        `${id} deprecationDate must be null or YYYY-MM-DD`,
      ).toBe(true)
    }
  })

  it('only the [1m] opus variant is flagged supports1M', () => {
    expect(MODEL_REGISTRY['claude-opus-4-8[1m]'].supports1M).toBe(true)
    expect(MODEL_REGISTRY['claude-opus-4-8'].supports1M).toBe(false)
    expect(MODEL_REGISTRY['claude-sonnet-4-6'].supports1M).toBe(false)
  })

  it('the local Ollama model is priced at zero (no API cost)', () => {
    const q = MODEL_REGISTRY['qwen3:4b']
    expect(q.inputPricePerMTok).toBe(0)
    expect(q.outputPricePerMTok).toBe(0)
  })
})

describe('MODEL_CONTEXT_WINDOWS back-compat projection', () => {
  it('still exposes the same window numbers the prior map held', () => {
    expect(MODEL_CONTEXT_WINDOWS['claude-opus-4-8[1m]']).toBe(1_000_000)
    expect(MODEL_CONTEXT_WINDOWS['claude-sonnet-4-6']).toBe(200_000)
    expect(MODEL_CONTEXT_WINDOWS['claude-haiku-4-5-20251001']).toBe(200_000)
  })

  it('is derived from the registry (every window matches)', () => {
    for (const [id, info] of Object.entries(MODEL_REGISTRY)) {
      expect(MODEL_CONTEXT_WINDOWS[id]).toBe(info.window)
    }
  })
})

describe('contextWindowForModel (behavior unchanged, now registry-backed)', () => {
  it('resolves known full ids and aliases', () => {
    expect(contextWindowForModel('claude-opus-4-8[1m]')).toBe(1_000_000)
    expect(contextWindowForModel('opus')).toBe(1_000_000) // alias -> [1m]
    expect(contextWindowForModel('sonnet')).toBe(200_000)
    expect(contextWindowForModel('haiku')).toBe(200_000)
  })

  it('the 1M opus and the standard opus are distinct windows', () => {
    expect(contextWindowForModel('claude-opus-4-8[1m]')).toBe(1_000_000)
    expect(contextWindowForModel('claude-opus-4-8')).toBe(200_000)
  })

  it('falls back to the default for unknown / empty ids', () => {
    expect(contextWindowForModel('totally-unknown')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(contextWindowForModel('')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(contextWindowForModel(null)).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(contextWindowForModel(undefined)).toBe(DEFAULT_CONTEXT_WINDOW)
  })
})

describe('modelInfoForModel', () => {
  it('returns the full info row for a known id (alias-resolved)', () => {
    const info = modelInfoForModel('opus')
    expect(info).not.toBeNull()
    expect(info!.window).toBe(1_000_000)
    expect(info!.supports1M).toBe(true)
  })

  it('returns null for an unknown / empty model', () => {
    expect(modelInfoForModel('nope')).toBeNull()
    expect(modelInfoForModel('')).toBeNull()
    expect(modelInfoForModel(null)).toBeNull()
  })
})

describe('costForUsageUsd', () => {
  it('prices input + output at the per-MTok list rate', () => {
    // sonnet: $3/MTok in, $15/MTok out. 1M in + 1M out = 3 + 15 = 18.
    expect(costForUsageUsd('claude-sonnet-4-6', 1_000_000, 1_000_000)).toBeCloseTo(18, 6)
    // opus 4.8: $5 in / $25 out. 200k in + 100k out = 1.0 + 2.5 = 3.5.
    expect(costForUsageUsd('claude-opus-4-8[1m]', 200_000, 100_000)).toBeCloseTo(3.5, 6)
  })

  it('is zero for a local (free) model', () => {
    expect(costForUsageUsd('qwen3:4b', 5_000_000, 2_000_000)).toBe(0)
  })

  it('returns null when the model is unknown (cannot price)', () => {
    expect(costForUsageUsd('mystery', 1000, 1000)).toBeNull()
  })

  it('treats missing/negative token counts as zero', () => {
    expect(costForUsageUsd('claude-sonnet-4-6', 0, 0)).toBe(0)
    expect(costForUsageUsd('claude-sonnet-4-6', -100, -100)).toBe(0)
  })
})

describe('isModelDeprecated', () => {
  it('flags a model whose retirement date is on/before the as-of date', () => {
    // claude-{sonnet,opus}-4-0 retired 2026-06-15 (model-migration memory).
    expect(isModelDeprecated('claude-opus-4-0', '2026-06-16')).toBe(true)
    expect(isModelDeprecated('claude-sonnet-4-0', '2026-06-15')).toBe(true)
  })

  it('does not flag before the retirement date', () => {
    expect(isModelDeprecated('claude-opus-4-0', '2026-06-14')).toBe(false)
  })

  it('does not flag current models (no announced retirement)', () => {
    expect(isModelDeprecated('claude-sonnet-4-6', '2030-01-01')).toBe(false)
    expect(isModelDeprecated('claude-opus-4-8[1m]', '2030-01-01')).toBe(false)
  })

  it('does not flag an unknown model', () => {
    expect(isModelDeprecated('whatever', '2030-01-01')).toBe(false)
  })
})

describe('modelSupports1M', () => {
  it('is true only for the 1M opus variant (alias-resolved)', () => {
    expect(modelSupports1M('claude-opus-4-8[1m]')).toBe(true)
    expect(modelSupports1M('opus')).toBe(true)
    expect(modelSupports1M('claude-opus-4-8')).toBe(false)
    expect(modelSupports1M('sonnet')).toBe(false)
    expect(modelSupports1M('unknown')).toBe(false)
  })
})
