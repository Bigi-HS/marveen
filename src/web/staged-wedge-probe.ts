/**
 * Pure decision core for the staged-input-wedge effect-probe (card 17aa045f, OPS-161).
 *
 * Background: PR#533 (2c5d6896) added the per-agent keepalive-log path and
 * comments; this module adds the REAL wedge detection: the pane-level effect
 * signal that confirms a heartbeat/task prompt is parked in the input buffer
 * without an Enter to submit it.
 *
 * The staged-input wedge shape (REPRO 2026-08-25 forge 21:16-21:45):
 *   - Multiple inbound messages to the agent stuck status='pending' for 30+ min.
 *   - Agent pane appears IDLE (no spinner / esc-to-interrupt) BUT input box is
 *     non-empty (a heartbeat injection landed without its trailing Enter).
 *   - Fix: one send-keys Enter unblocks the session. No restart needed.
 *
 * This module takes the SIGNALS already available in the monitoring sweep
 * (pending-message age from agent_messages table + pane state from
 * detectPaneState) and returns a classified verdict so the monitor can choose
 * the right recovery action.
 *
 * Design: pure over injected inputs, zero imports from tmux or DB layers, so
 * the adversarial fixtures in the test file can cover every branch without I/O.
 * The I/O (capturePane + DB query) lives in the host monitoring loop.
 */

import type { PaneState } from '../pane-state.js'

/**
 * The per-agent signals the host loop must gather and inject.
 * All timing in minutes so thresholds read naturally at the call site.
 */
export interface StagedWedgeSignal {
  /** Is there at least one pending (delivered_at NULL) inbound message for this agent? */
  hasPendingInbound: boolean
  /** Age (minutes) of the OLDEST pending inbound. 0 when hasPendingInbound is false. */
  oldestPendingAgeMin: number
  /** How old must the oldest pending be (minutes) before we treat it as a wedge candidate?
   *  Prevents false positives on a freshly-enqueued message that has not yet been picked
   *  up by the first router tick. Default 15 in DEFAULT_STAGED_WEDGE_THRESHOLDS. */
  overdueThresholdMin: number
  /** Pane state from detectPaneState() (or null / 'unknown' when capture failed). */
  paneState: PaneState | null
}

/**
 * The probe's output: four mutually-exclusive verdicts.
 *
 *   staged-wedge    -- pane is 'typing' (non-empty input) + overdue pending inbound.
 *                      Recovery: send one Enter to the session (NOT a full restart).
 *   busy            -- pane is 'busy' (spinner mid-turn). Queue will drain; do not act.
 *   pending-idle    -- overdue pending + pane is 'idle' (empty input).
 *                      A routing / wrong-target issue, not a pane-level wedge.
 *   no-pending      -- inbox is empty or below threshold. No problem to diagnose.
 *   below-threshold -- pending exists but is not yet overdue. Monitor and re-check.
 *   unknown         -- pane capture failed; cannot classify.
 *   error           -- thinking-block API error; separate escalation path (not Enter-recoverable).
 */
export type StagedWedgeVerdict =
  | 'staged-wedge'
  | 'busy'
  | 'pending-idle'
  | 'no-pending'
  | 'below-threshold'
  | 'unknown'
  | 'error'

/**
 * Classify the agent's current wedge state from the injected signals.
 *
 * Order of precedence (each check can short-circuit):
 *  1. No pending inbound -> 'no-pending'.
 *  2. Pending exists but below the overdue threshold -> 'below-threshold'.
 *  3. Pane capture failed (null) or 'unknown' -> 'unknown'.
 *  4. Pane 'error' (thinking-block) -> 'error' (not Enter-recoverable).
 *  5. Pane 'busy' (spinner) -> 'busy' (turn in progress; queue drains after turn).
 *  6. Pane 'typing' (input non-empty, no spinner) -> 'staged-wedge'.
 *  7. Pane 'idle' (empty input, no spinner) -> 'pending-idle' (routing/target issue).
 */
export function classifyStagedWedgeProbe(signal: StagedWedgeSignal): StagedWedgeVerdict {
  // 1. Empty inbox.
  if (!signal.hasPendingInbound) return 'no-pending'

  // 2. Pending but not yet overdue.
  if (signal.oldestPendingAgeMin < signal.overdueThresholdMin) return 'below-threshold'

  // 3. Pane unknown / capture failed.
  if (signal.paneState == null || signal.paneState === 'unknown') return 'unknown'

  // 4. Thinking-block API error -- separate path.
  if (signal.paneState === 'error') return 'error'

  // 5. True busy -- agent is mid-turn, message will be picked up after completion.
  if (signal.paneState === 'busy') return 'busy'

  // 6. Staged-input wedge: input non-empty but no spinner. One Enter unblocks it.
  if (signal.paneState === 'typing') return 'staged-wedge'

  // 7. Idle pane with empty input -- routing or addressing issue, not pane-level.
  return 'pending-idle'
}

/** True when the verdict requires a recovery Enter to the agent's session. */
export function isTypingWedge(verdict: StagedWedgeVerdict): verdict is 'staged-wedge' {
  return verdict === 'staged-wedge'
}

/** Sensible defaults: 15-min overdue threshold matches the wedge pattern observed in incidents. */
export const DEFAULT_STAGED_WEDGE_THRESHOLDS = {
  overdueThresholdMin: 15,
} as const
