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

// Per-agent bookkeeping for the SLICE-2 recovery Enter (card 4702232f).
// Once a staged-wedge is confirmed (15-min overdue threshold already done by
// classifyStagedWedgeProbe), a single Enter typically unblocks it. Track the
// last send and attempt count so the watcher does not hammer a session that
// is stuck for a reason a bare Enter cannot fix.
export interface StagedWedgeEnterState {
  /** Epoch-ms of the last recovery Enter sent, or null if none yet. */
  lastEnterAt: number | null
  /** How many recovery Enters have been sent in the current spell. */
  attempts: number
}

export interface StagedWedgeEnterThresholds {
  /** Minimum gap between recovery Enters (ms). Default 60s. */
  cooldownMs: number
  /** Max Enters per spell before giving up -- Enter is not fixing it. Default 3. */
  maxAttempts: number
}

export const DEFAULT_STAGED_WEDGE_ENTER_THRESHOLDS: StagedWedgeEnterThresholds = {
  cooldownMs: 60_000,
  maxAttempts: 3,
}

/**
 * Pure decision: should a recovery Enter be sent to the wedged agent?
 *
 * Non staged-wedge verdicts always reset state (spell ended / healthy).
 * On staged-wedge: send immediately the first time; then respect the
 * cooldown; give up after maxAttempts (the wedge is not Enter-recoverable).
 */
export function decideStagedWedgeEnter(
  verdict: StagedWedgeVerdict,
  prev: StagedWedgeEnterState,
  nowMs: number,
  t: StagedWedgeEnterThresholds = DEFAULT_STAGED_WEDGE_ENTER_THRESHOLDS,
): { send: boolean; next: StagedWedgeEnterState } {
  const clean: StagedWedgeEnterState = { lastEnterAt: null, attempts: 0 }
  if (verdict !== 'staged-wedge') return { send: false, next: clean }
  if (prev.attempts >= t.maxAttempts) return { send: false, next: prev }
  if (prev.lastEnterAt !== null && nowMs - prev.lastEnterAt < t.cooldownMs) {
    return { send: false, next: prev }
  }
  return { send: true, next: { lastEnterAt: nowMs, attempts: prev.attempts + 1 } }
}

/**
 * Convert a DB-stored epoch-SECONDS timestamp (agent_messages.created_at,
 * db.ts: Math.floor(Date.now()/1000)) to an age in whole minutes relative
 * to a caller-supplied clock (nowMs in milliseconds).
 *
 * Extracted from channel-monitor.ts so the conversion is unit-testable and
 * the call-site cannot accidentally mix epoch-ms with epoch-sec again.
 * Returns 0 for future-dated created_at (clock skew guard, never negative).
 */
export function pendingAgeMinutes(nowMs: number, oldestCreatedAtSec: number): number {
  const ageSec = Math.floor(nowMs / 1000) - oldestCreatedAtSec
  return Math.max(0, Math.floor(ageSec / 60))
}

/**
 * Content-safety gate for the staged-input wedge recovery Enter (card 7e0b0cce,
 * hardened in cards cf84e0a6 + 44ae9e4c).
 *
 * Risk: auto-submitting a recovery Enter on unrecognized staged content sends
 * arbitrary text typed by the user or by a prior tool invocation (Claudia
 * 6h-wedge precedent 2026-08-24). The gate only proceeds when the pane shows a
 * recognized injected task/heartbeat/inter-agent message.
 *
 * FAIL-CLOSED (card 44ae9e4c, Chad SEC flag #1835): the gate ABSTAINS unless it
 * can positively confirm a safe injected message. In particular an unreadable
 * (null) or empty pane now abstains rather than firing -- previously it returned
 * true (fail-open), so a pane-read failure would auto-submit. A real wedge always
 * presents a non-empty typing-state pane, so fail-closing null/empty does not
 * break any legitimate recovery (the call-site only reaches here when the pane
 * was classified typing + the inbox is overdue).
 *
 * LINE-SCOPED MATCH (card cf84e0a6): the injected message sits inside the TUI
 * input box, i.e. mid-pane, NOT at the start of the captured pane. The previous
 * `trimmed.startsWith(prefix)` matched the whole pane and so almost always
 * abstained on a real capture (the prefix is never the first character). We now
 * scan each line, strip leading TUI chrome (prompt markers / box borders), and
 * accept when a STAGED LINE begins with a recognized prefix. A prefix appearing
 * mid-line (e.g. "I have a question about [Heartbeat]...") is still rejected.
 *
 * The blanket "<=40 chars -> true" short-circuit (Chad flag #2) is removed: short
 * content must also present a recognized prefix line, else it abstains.
 *
 * Recognized prefixes (case-insensitive):
 *   [Uzenet, [Task, [Heartbeat, [Scheduled, [Inter-agent, [Feladat
 */

const SAFE_PREFIXES: ReadonlyArray<string> = [
  '[uzenet',
  '[task',
  '[heartbeat',
  '[scheduled',
  '[inter-agent',
  '[feladat',
]

// Leading TUI chrome stripped before the per-line prefix test: whitespace, the
// prompt marker '>', and common box-drawing borders tmux/Ink render around the
// input box. Keeps the match anchored to the start of the staged line while
// tolerating the box chrome that precedes it in a real pane capture.
const LEADING_CHROME_RE = /^[\s>│|╎┃┆┊*\-─]+/

export function isSafeToAutoEnter(paneContent: string | null): boolean {
  // Fail-closed: unreadable pane -> abstain (card 44ae9e4c flag-1).
  if (paneContent == null) return false
  const trimmed = paneContent.trim()
  // Fail-closed: nothing we can positively recognize -> abstain.
  if (trimmed.length === 0) return false
  for (const line of trimmed.split('\n')) {
    const stripped = line.replace(LEADING_CHROME_RE, '').trim().toLowerCase()
    if (SAFE_PREFIXES.some((prefix) => stripped.startsWith(prefix))) return true
  }
  return false
}
