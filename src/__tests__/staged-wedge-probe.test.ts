/**
 * Adversarial fixtures for the staged-input-wedge effect-probe (card 17aa045f, OPS-161).
 *
 * The probe discriminates FOUR cases from the card:
 *   F1. staged-wedge   -- pending inbound + pane 'typing' (idle, non-empty input)
 *                         The fix: send an Enter. MUST alert.
 *   F2. true-busy      -- pending inbound + pane 'busy' (spinner visible)
 *                         Agent is working; queue will drain. Must NOT alert.
 *   F3. pending-idle   -- pending inbound + pane 'idle' (empty input)
 *                         Queue or routing issue, not a pane wedge. Distinguished from F1.
 *   F4. no-pending     -- inbox empty. No problem regardless of pane state.
 *
 * Bonus fixtures:
 *   F5. pane unknown   -- capture failed or not a Claude Code surface.
 *   F6. pane error     -- thinking-block error wedge (separate escalation path).
 *   F7. overdue guard  -- pending exists but below the overdue threshold -> not yet a wedge.
 */
import { describe, it, expect } from 'vitest'
import {
  classifyStagedWedgeProbe,
  isTypingWedge,
  type StagedWedgeSignal,
  type StagedWedgeVerdict,
} from '../web/staged-wedge-probe.js'

function sig(overrides: Partial<StagedWedgeSignal> = {}): StagedWedgeSignal {
  return {
    hasPendingInbound: false,
    oldestPendingAgeMin: 0,
    overdueThresholdMin: 15,
    paneState: 'idle',
    ...overrides,
  }
}

describe('classifyStagedWedgeProbe', () => {
  // F1: staged-wedge -- the fix is a send-Enter, this must surface as an alert.
  it('F1: typing pane + overdue pending => staged-wedge', () => {
    const v: StagedWedgeVerdict = classifyStagedWedgeProbe(sig({
      hasPendingInbound: true,
      oldestPendingAgeMin: 30, // above 15-min threshold
      paneState: 'typing',
    }))
    expect(v).toBe('staged-wedge')
  })

  // F2: true-busy -- agent is processing; do NOT alert.
  it('F2: busy pane + overdue pending => busy (no alert)', () => {
    const v = classifyStagedWedgeProbe(sig({
      hasPendingInbound: true,
      oldestPendingAgeMin: 40,
      paneState: 'busy',
    }))
    expect(v).toBe('busy')
  })

  // F3: pending but pane idle-empty-input -- wrong-target / routing issue, NOT a typing wedge.
  it('F3: idle pane + overdue pending => pending-idle (distinguished from staged-wedge)', () => {
    const v = classifyStagedWedgeProbe(sig({
      hasPendingInbound: true,
      oldestPendingAgeMin: 40,
      paneState: 'idle',
    }))
    expect(v).toBe('pending-idle')
  })

  // F4: no pending messages -> healthy regardless of pane state.
  it('F4: no pending messages => no-pending', () => {
    const v = classifyStagedWedgeProbe(sig({
      hasPendingInbound: false,
      paneState: 'typing', // even a parked input without pending = normal composing
    }))
    expect(v).toBe('no-pending')
  })

  // F5: pane capture failed (unknown) -- cannot classify the wedge.
  it('F5: unknown pane + pending => unknown (capture failed)', () => {
    const v = classifyStagedWedgeProbe(sig({
      hasPendingInbound: true,
      oldestPendingAgeMin: 30,
      paneState: 'unknown',
    }))
    expect(v).toBe('unknown')
  })

  // F6: thinking-block error + pending -- separate escalation path, not Enter-recoverable.
  it('F6: error pane + pending => error (thinking-block wedge, not Enter-recoverable)', () => {
    const v = classifyStagedWedgeProbe(sig({
      hasPendingInbound: true,
      oldestPendingAgeMin: 30,
      paneState: 'error',
    }))
    expect(v).toBe('error')
  })

  // F7: pending exists but below the overdue threshold -> not yet a wedge.
  it('F7: pending below overdue threshold => below-threshold (not yet a wedge)', () => {
    const v = classifyStagedWedgeProbe(sig({
      hasPendingInbound: true,
      oldestPendingAgeMin: 5, // 5 min < 15 min threshold
      overdueThresholdMin: 15,
      paneState: 'typing',
    }))
    expect(v).toBe('below-threshold')
  })

  // Regression: created_at unit-mismatch (dave BLOCK PR#766).
  // agent_messages.created_at is epoch SECONDS (db.ts: Math.floor(Date.now()/1000)).
  // A naive `Date.now() - created_at_seconds` yields ~30M minutes (always overdue).
  // The correct computation: `(Date.now()/1000 - created_at_seconds) / 60`.
  // A 1-second-old message has age ~0 minutes -> below any reasonable threshold.
  // This fixture would FAIL under the buggy (ms - sec) calculation because
  // oldestPendingAgeMin would be ~30M, making `paneState: 'typing'` fire staged-wedge.
  it('F8 (regression unit-mismatch): 0-min-old pending + typing pane => below-threshold, not staged-wedge', () => {
    // 0 minutes old: a message enqueued <1 min ago is never a wedge candidate yet.
    const v = classifyStagedWedgeProbe(sig({
      hasPendingInbound: true,
      oldestPendingAgeMin: 0, // would be ~30M under the buggy ms-epoch computation
      overdueThresholdMin: 15,
      paneState: 'typing',
    }))
    expect(v).toBe('below-threshold')
  })

  // The staged-wedge verdict is also a predicate: isTypingWedge.
  it('isTypingWedge is true only for staged-wedge verdict', () => {
    expect(isTypingWedge('staged-wedge')).toBe(true)
    expect(isTypingWedge('busy')).toBe(false)
    expect(isTypingWedge('pending-idle')).toBe(false)
    expect(isTypingWedge('no-pending')).toBe(false)
  })
})
