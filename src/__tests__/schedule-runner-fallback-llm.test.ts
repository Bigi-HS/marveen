// Schedule-runner routing-decision tests for the token-outage Layer-2 fallback
// LLM bypass (card 92f07145, spec store/spec-layer2-fallback-llm.md AC-1).
//
// As with the Layer-1 direct-send tests, the runner is tmux/DB-coupled, so we
// cover the pure routing predicate (shouldFallbackLLM) here. AC-1c is the key
// invariant: Layer 2 only fires when Layer 1 did NOT (directSend !== true), so
// a task never falls through both paths.

import { describe, it, expect } from 'vitest'
import { shouldFallbackLLM, shouldDirectSend } from '../web/schedule-runner.js'

const limited = { limited: true }
const healthy = { limited: false }

describe('shouldFallbackLLM (AC-1 Layer-2 trigger)', () => {
  it('limited + layer2=true + directSend absent -> fires Layer 2', () => {
    expect(shouldFallbackLLM({ layer2: true }, limited)).toBe(true)
  })

  it('limited + layer2=true + directSend=false -> fires Layer 2', () => {
    expect(shouldFallbackLLM({ layer2: true, directSend: false }, limited)).toBe(true)
  })

  it('AC-1c: limited + layer2=true + directSend=true -> Layer 1 owns it, NOT Layer 2', () => {
    expect(shouldFallbackLLM({ layer2: true, directSend: true }, limited)).toBe(false)
  })

  it('NOT limited + layer2=true -> normal path', () => {
    expect(shouldFallbackLLM({ layer2: true }, healthy)).toBe(false)
  })

  it('limited + layer2 absent -> normal path', () => {
    expect(shouldFallbackLLM({}, limited)).toBe(false)
  })

  it('limited + layer2=false -> normal path', () => {
    expect(shouldFallbackLLM({ layer2: false }, limited)).toBe(false)
  })

  it('null/absent state -> normal path', () => {
    expect(shouldFallbackLLM({ layer2: true }, null)).toBe(false)
  })
})

describe('Layer-1 / Layer-2 mutual exclusivity (no double-fire, no fall-through)', () => {
  // For every task shape under a limited state, at most one layer claims it.
  const shapes = [
    { directSend: true, layer2: true },
    { directSend: true, layer2: false },
    { directSend: false, layer2: true },
    { directSend: false, layer2: false },
    { layer2: true },
    {},
  ]
  it('directSend and layer2 are never both true for the same tick', () => {
    for (const s of shapes) {
      const l1 = shouldDirectSend(s, limited)
      const l2 = shouldFallbackLLM(s, limited)
      expect(l1 && l2).toBe(false)
    }
  })

  it('a directSend task always routes to Layer 1, never Layer 2', () => {
    expect(shouldDirectSend({ directSend: true }, limited)).toBe(true)
    expect(shouldFallbackLLM({ directSend: true, layer2: true }, limited)).toBe(false)
  })
})
