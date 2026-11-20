// Unit tests for the cross-source SessionStart continuity-budget accumulator
// (memory-continuity Phase 1, S3 hardening -- card 7126a3df).
//
// Tests cover:
//   - Basic claim / budget accounting
//   - Combined hard-cap enforcement (the DANGEROUS path: all three sources fire)
//   - Per-source idempotency (retry safety)
//   - Boot-window expiry (new boot resets the slot)
//   - Fail-safe: sources below the cap always succeed even if one is refused
//   - Agent name sanitisation (path-traversal can't share a slot)

import { describe, it, expect } from 'vitest'
import {
  claimContinuityBudget,
  resetContinuityBudget,
  inspectContinuityBudget,
  COMBINED_CONTINUITY_BUDGET,
  BOOT_WINDOW_MS,
  type BudgetMap,
} from '../web/continuity-budget.js'

// Each test group uses an isolated BudgetMap so there is no cross-test state.
function freshMap(): BudgetMap { return new Map() }

const AGENT = 'test-agent'
const T0 = 1_700_000_000_000  // arbitrary epoch ms base

describe('continuity-budget -- basic accounting', () => {
  it('first claim on an empty map is allowed', () => {
    const m = freshMap()
    const r = claimContinuityBudget(AGENT, 'checkpoint', 100, T0, m)
    expect(r.allowed).toBe(true)
    expect(r.usedAfter).toBe(100)
    expect(r.remaining).toBe(COMBINED_CONTINUITY_BUDGET)  // remaining BEFORE claim
  })

  it('successive claims within the boot window accumulate', () => {
    const m = freshMap()
    claimContinuityBudget(AGENT, 'checkpoint', 3000, T0, m)
    const r = claimContinuityBudget(AGENT, 'ledger', 2000, T0 + 100, m)
    expect(r.allowed).toBe(true)
    expect(r.usedAfter).toBe(5000)
  })

  it('slot tracks which sources have claimed', () => {
    const m = freshMap()
    claimContinuityBudget(AGENT, 'checkpoint', 100, T0, m)
    claimContinuityBudget(AGENT, 'ledger', 200, T0 + 100, m)
    const slot = inspectContinuityBudget(AGENT, m)
    expect(slot?.sources.has('checkpoint')).toBe(true)
    expect(slot?.sources.has('ledger')).toBe(true)
    expect(slot?.sources.has('memory')).toBe(false)
  })
})

describe('continuity-budget -- DANGEROUS path: combined hard cap', () => {
  it('a claim that would exceed the combined cap is REFUSED', () => {
    const m = freshMap()
    // Fill the budget almost to the top.
    claimContinuityBudget(AGENT, 'checkpoint', COMBINED_CONTINUITY_BUDGET - 100, T0, m)
    // This claim would push total over the cap.
    const r = claimContinuityBudget(AGENT, 'ledger', 200, T0 + 100, m)
    expect(r.allowed).toBe(false)
    // usedAfter must NOT change when a claim is refused.
    expect(r.usedAfter).toBe(COMBINED_CONTINUITY_BUDGET - 100)
  })

  it('all three sources firing simultaneously: third is refused when budget exhausted', () => {
    const m = freshMap()
    // Simulate the worst case: reversed hook order means checkpoint+ledger both
    // claim large windows before the dedup path runs.
    const cpChars = 4000   // checkpoint lastTurns cap
    const ldChars = 4000   // ledger window (should normally be suppressed)
    const memChars = 1500  // memory inject

    const cp = claimContinuityBudget(AGENT, 'checkpoint', cpChars, T0, m)
    const ld = claimContinuityBudget(AGENT, 'ledger', ldChars, T0 + 50, m)
    const mem = claimContinuityBudget(AGENT, 'memory', memChars, T0 + 100, m)

    expect(cp.allowed).toBe(true)
    expect(ld.allowed).toBe(true)
    // checkpoint(4000) + ledger(4000) = 8000 = exactly the cap. memory is refused.
    expect(mem.allowed).toBe(false)
    expect(inspectContinuityBudget(AGENT, m)?.usedChars).toBe(COMBINED_CONTINUITY_BUDGET)
  })

  it('total stays at or under COMBINED_CONTINUITY_BUDGET regardless of injection count', () => {
    const m = freshMap()
    const claims = [
      { source: 'checkpoint', chars: 5000 },
      { source: 'ledger',     chars: 5000 },
      { source: 'memory',     chars: 2000 },
    ]
    for (const { source, chars } of claims) {
      claimContinuityBudget(AGENT, source, chars, T0, m)
    }
    const slot = inspectContinuityBudget(AGENT, m)
    expect(slot?.usedChars).toBeLessThanOrEqual(COMBINED_CONTINUITY_BUDGET)
  })

  it('a claim of exactly the remaining budget is allowed; next claim is refused', () => {
    const m = freshMap()
    claimContinuityBudget(AGENT, 'checkpoint', 6000, T0, m)
    const exact = claimContinuityBudget(AGENT, 'ledger', 2000, T0 + 50, m)
    const overflow = claimContinuityBudget(AGENT, 'memory', 1, T0 + 100, m)
    expect(exact.allowed).toBe(true)
    expect(overflow.allowed).toBe(false)
  })
})

describe('continuity-budget -- idempotency (retry safety)', () => {
  it('a second claim from the same source in the same boot window is a no-op', () => {
    const m = freshMap()
    const r1 = claimContinuityBudget(AGENT, 'checkpoint', 2000, T0, m)
    const r2 = claimContinuityBudget(AGENT, 'checkpoint', 2000, T0 + 100, m)
    expect(r1.allowed).toBe(true)
    expect(r2.allowed).toBe(true)  // idempotent: allowed but NOT double-counted
    expect(inspectContinuityBudget(AGENT, m)?.usedChars).toBe(2000)  // counted once
  })

  it('idempotent retry does not block other sources', () => {
    const m = freshMap()
    claimContinuityBudget(AGENT, 'checkpoint', 4000, T0, m)
    claimContinuityBudget(AGENT, 'checkpoint', 4000, T0 + 50, m)  // retry
    const ledger = claimContinuityBudget(AGENT, 'ledger', 2000, T0 + 100, m)
    expect(ledger.allowed).toBe(true)
    expect(inspectContinuityBudget(AGENT, m)?.usedChars).toBe(6000)
  })
})

describe('continuity-budget -- boot-window expiry', () => {
  it('a claim after BOOT_WINDOW_MS opens a fresh boot and resets the budget', () => {
    const m = freshMap()
    claimContinuityBudget(AGENT, 'checkpoint', COMBINED_CONTINUITY_BUDGET, T0, m)
    // First boot: budget exhausted.
    const refused = claimContinuityBudget(AGENT, 'ledger', 100, T0 + 100, m)
    expect(refused.allowed).toBe(false)
    // After the window expires, next boot gets a fresh 8000-char budget.
    const newBoot = claimContinuityBudget(AGENT, 'checkpoint', 100, T0 + BOOT_WINDOW_MS + 1, m)
    expect(newBoot.allowed).toBe(true)
    expect(inspectContinuityBudget(AGENT, m)?.usedChars).toBe(100)
  })
})

describe('continuity-budget -- resetContinuityBudget', () => {
  it('reset clears the slot so the next claim starts fresh', () => {
    const m = freshMap()
    claimContinuityBudget(AGENT, 'checkpoint', COMBINED_CONTINUITY_BUDGET, T0, m)
    expect(claimContinuityBudget(AGENT, 'ledger', 100, T0 + 100, m).allowed).toBe(false)
    resetContinuityBudget(AGENT, m)
    expect(claimContinuityBudget(AGENT, 'ledger', 100, T0 + 200, m).allowed).toBe(true)
  })
})

describe('continuity-budget -- agent name sanitisation', () => {
  it('path-traversal chars are stripped so a crafted name cannot steal another agent slot', () => {
    const m = freshMap()
    claimContinuityBudget('../../etc/passwd', 'checkpoint', COMBINED_CONTINUITY_BUDGET, T0, m)
    // The same normalised key: 'etcpasswd'
    const sameName = claimContinuityBudget('etcpasswd', 'ledger', 100, T0 + 100, m)
    // Both map to the same sanitised key -- second claim is refused (budget exhausted).
    expect(sameName.allowed).toBe(false)
  })

  it('distinct agent names use independent slots', () => {
    const m = freshMap()
    claimContinuityBudget('agentA', 'checkpoint', COMBINED_CONTINUITY_BUDGET, T0, m)
    const r = claimContinuityBudget('agentB', 'checkpoint', 100, T0 + 100, m)
    expect(r.allowed).toBe(true)
  })
})

describe('continuity-budget -- remaining field', () => {
  it('remaining is the budget available BEFORE the current claim', () => {
    const m = freshMap()
    const r1 = claimContinuityBudget(AGENT, 'checkpoint', 1000, T0, m)
    expect(r1.remaining).toBe(COMBINED_CONTINUITY_BUDGET)  // nothing used yet when checked
    const r2 = claimContinuityBudget(AGENT, 'ledger', 500, T0 + 50, m)
    expect(r2.remaining).toBe(COMBINED_CONTINUITY_BUDGET - 1000)
  })
})
