// Rate-limit governor -- notify-first MVP (card fd30873b).
//
// The shared-account five-hour rate limit is the fleet's main freeze risk: when
// it is exhausted, every agent's next call stalls. Claude Code reports the live
// usage on the status line's stdin (rate_limits.five_hour.used_percentage +
// resets_at), which genesis-statusline.py persists to ~/.claude/statusline-last.json
// (Delta1). This governor polls that snapshot and, when usage crosses 96%, emits
// ONE notification carrying the exact resume time (the reset + a 2-minute grace,
// in Europe/Budapest) and ONE "resumed" notification once that time passes.
//
// This is the NOTIFY-FIRST stage: it only notifies. Actually pausing the fleet's
// processes is a separate, Boss-gated step (P2) and is deliberately not done here.
//
// The core (evaluateGovernor) is pure so the threshold/grace/dedup logic is
// unit-tested directly; IO is injected via GovernorDeps so a cycle can run with
// mock snapshot/state/notify and no DB or filesystem.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import type { FleetPauseRecord } from './fleet-pause.js'

// Usage at/above this percentage of the five-hour window triggers a pause.
// Boss decision 2026-06-08: auto-pause enabled, threshold 98% (was 96% notify-
// only) -- a tighter margin now that crossing it actually pauses the fleet.
export const PAUSE_THRESHOLD_PCT = 98
// Wait this long PAST resets_at before declaring the window resumed: the reset is
// not instantaneous and a couple of minutes of slack avoids a resume-then-repause
// flap right on the boundary.
export const RESUME_GRACE_SEC = 120

// Where Delta1 persists the latest status-line snapshot. Overridable for tests.
export const SNAPSHOT_PATH =
  process.env.STATUSLINE_LAST_PATH || join(homedir(), '.claude', 'statusline-last.json')
// Where the governor persists its own episode state (so it notifies once, not on
// every poll, and survives a restart mid-episode).
export const STATE_PATH = join(PROJECT_ROOT, 'store', '.rate-limit-governor-state.json')

export type GovernorPhase = 'normal' | 'paused'

export interface GovernorState {
  phase: GovernorPhase
  // resets_at (epoch seconds) of the episode we paused on; null while normal.
  resetsAt: number | null
  // Timestamps of the notifications already sent this episode (dedup + audit).
  pauseNotifiedAt: number | null
  resumeNotifiedAt: number | null
}

export const INITIAL_STATE: GovernorState = {
  phase: 'normal',
  resetsAt: null,
  pauseNotifiedAt: null,
  resumeNotifiedAt: null,
}

export interface Snapshot {
  captured_at?: number
  rate_limits?: { five_hour?: { used_percentage?: number; resets_at?: number } }
}

export type GovernorAction = 'none' | 'pause' | 'resume'

export interface GovernorDecision {
  action: GovernorAction
  message: string | null
  state: GovernorState
}

// Format an epoch-seconds instant in Europe/Budapest (the fleet's canonical TZ),
// e.g. "2026. 06. 08. 14:32". Pure given the timestamp.
export function formatBudapestTime(epochSec: number): string {
  return new Intl.DateTimeFormat('hu-HU', {
    timeZone: 'Europe/Budapest',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(epochSec * 1000))
}

function pauseMessage(pct: number, resumeAtSec: number): string {
  return (
    `Rate-limit governor: a token-hasznalat eleri a ${pct}%-ot (>=${PAUSE_THRESHOLD_PCT}%). ` +
    `A flotta szuneteltetese javasolt. Folytatas a reset utan 2 perccel: ` +
    `${formatBudapestTime(resumeAtSec)} (Europe/Budapest).`
  )
}

function resumeMessage(resumeAtSec: number): string {
  return `Rate-limit governor: a reset megvolt (${formatBudapestTime(resumeAtSec)}), folytatjuk.`
}

// Pure decision: given the latest snapshot and the persisted state, decide
// whether to emit a pause or resume notice and what the next state is. No IO.
export function evaluateGovernor(
  snapshot: Snapshot | null,
  state: GovernorState,
  nowSec: number,
): GovernorDecision {
  const five = snapshot?.rate_limits?.five_hour
  const pct = typeof five?.used_percentage === 'number' ? five.used_percentage : null
  const resetsAt = typeof five?.resets_at === 'number' ? five.resets_at : null

  // PAUSE: usage crossed the threshold while we were running normally. Requires a
  // resets_at so we can tell the operator (and ourselves) when to resume; without
  // it we cannot schedule a resume, so we hold off rather than pause blind.
  if (state.phase === 'normal' && pct !== null && pct >= PAUSE_THRESHOLD_PCT && resetsAt !== null) {
    const resumeAt = resetsAt + RESUME_GRACE_SEC
    return {
      action: 'pause',
      message: pauseMessage(pct, resumeAt),
      state: { phase: 'paused', resetsAt, pauseNotifiedAt: nowSec, resumeNotifiedAt: null },
    }
  }

  // RESUME: we were paused and the grace period after the episode's reset passed.
  if (state.phase === 'paused' && state.resetsAt !== null && nowSec >= state.resetsAt + RESUME_GRACE_SEC) {
    const resumeAt = state.resetsAt + RESUME_GRACE_SEC
    return {
      action: 'resume',
      message: resumeMessage(resumeAt),
      state: { phase: 'normal', resetsAt: null, pauseNotifiedAt: state.pauseNotifiedAt, resumeNotifiedAt: nowSec },
    }
  }

  // No transition: already paused and waiting, or normal and below threshold.
  return { action: 'none', message: null, state }
}

// --- File-backed IO (defaults; injectable for tests) ---

export function readSnapshotFile(path: string = SNAPSHOT_PATH): Snapshot | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Snapshot) : null
  } catch {
    return null
  }
}

export function readStateFile(path: string = STATE_PATH): GovernorState {
  try {
    const p = JSON.parse(readFileSync(path, 'utf-8')) as Partial<GovernorState>
    return {
      phase: p.phase === 'paused' ? 'paused' : 'normal',
      resetsAt: typeof p.resetsAt === 'number' ? p.resetsAt : null,
      pauseNotifiedAt: typeof p.pauseNotifiedAt === 'number' ? p.pauseNotifiedAt : null,
      resumeNotifiedAt: typeof p.resumeNotifiedAt === 'number' ? p.resumeNotifiedAt : null,
    }
  } catch {
    return { ...INITIAL_STATE }
  }
}

export function writeStateFile(state: GovernorState, path: string = STATE_PATH): void {
  try {
    atomicWriteFileSync(path, JSON.stringify(state), { mode: 0o600 })
  } catch {
    /* best-effort: a missed write only re-notifies next cycle, never crashes */
  }
}

export interface GovernorDeps {
  readSnapshot(): Snapshot | null
  readState(): GovernorState
  writeState(state: GovernorState): void
  notify(message: string): void
  nowSec(): number
  // P2 fleet-pause: declare/clear the pause sentinel on a pause/resume transition.
  // Injected so a cycle is testable without touching the real sentinel file, and
  // so the CLI can choose a dry (sentinel-only) vs enforcing wiring. Optional for
  // back-compat with notify-only callers/tests.
  pauseFleet?(record: FleetPauseRecord): void
  resumeFleet?(): void
}

export interface GovernorCycleResult {
  action: GovernorAction
  message: string | null
  pct: number | null
}

// Run one governor cycle: read the snapshot + state, decide, and on a transition
// notify and persist. Returns the action taken (for logging by the CLI).
export function runGovernorCycle(deps: GovernorDeps): GovernorCycleResult {
  const snapshot = deps.readSnapshot()
  const state = deps.readState()
  const now = deps.nowSec()
  const decision = evaluateGovernor(snapshot, state, now)
  const pctVal = snapshot?.rate_limits?.five_hour?.used_percentage
  const pct = typeof pctVal === 'number' ? pctVal : null
  if (decision.action !== 'none') {
    // Declare/clear the fleet-pause sentinel BEFORE notifying, so the operator's
    // "paused" message is never sent ahead of the state it describes. Both are
    // best-effort in their impls; a sentinel miss only re-acts next cycle.
    if (decision.action === 'pause' && decision.state.resetsAt !== null) {
      deps.pauseFleet?.({
        pausedAt: now,
        resumeAt: decision.state.resetsAt + RESUME_GRACE_SEC,
        pct,
        reason: `five_hour usage >= ${PAUSE_THRESHOLD_PCT}%`,
      })
    } else if (decision.action === 'resume') {
      deps.resumeFleet?.()
    }
    if (decision.message) deps.notify(decision.message)
    deps.writeState(decision.state)
  }
  return { action: decision.action, message: decision.message, pct }
}
