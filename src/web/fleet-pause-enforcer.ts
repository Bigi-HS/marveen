// Fleet-pause ENFORCER (card fd30873b -- the live-enforcement wiring on top of
// the #82 sentinel). The rate-limit governor writes the fleet-pause sentinel
// (fleet-pause.ts); THIS module is the consumer that holds off PROACTIVE work
// initiation while the fleet is paused, so the shared five-hour token window is
// not pushed further past the limit and can reset.
//
// ACTIVATION IS FLAG-GATED AND OFF BY DEFAULT. The mode comes from
// FLEET_PAUSE_ENFORCE (off | dry-run | enforce); unset/unknown => 'off'. In
// 'off' the gate is a zero-overhead no-op (it does not even read the sentinel),
// so MERGING this changes nothing live -- the blast-radius is zero until an
// operator flips the flag, which is a SEPARATE Boss-gated step (the #82/#50
// pattern). 'dry-run' logs what 'enforce' WOULD hold without holding. 'enforce'
// actually holds.
//
// WHERE it is wired (the proactive token-burn initiators), and what is
// deliberately EXEMPT:
//   GATED   - schedule-runner task fire (cron + heartbeat tasks)
//   GATED   - inter-agent message-router delivery
//   GATED   - session-size-watcher /compact (it is itself a model call; under a
//             token-budget pause -- today's only pause reason -- a /compact would
//             burn the exhausted window. DA HIGH-1/MEDIUM-1.)
//   EXEMPT  - channel-monitor main-session respawn / --continue (RECOVERY of the
//             Telegram host + the governor's own notify path; pausing it could
//             strand fleet comms and the "resumed" message. DA HIGH-2.)
//   EXEMPT  - stuck-input recovery Enter, /login, chameleon sandbox (recovery /
//             auth / test, not proactive new work).
//
// FAIL-OPEN: any error resolving the pause state means "do not hold". isFleetPaused
// is already fail-safe (missing/corrupt sentinel => not paused, self-expiring), so
// the worst case is a few extra injects during a transient read glitch -- bounded,
// and far preferable to wedging the fleet on a sentinel bug. (DA MEDIUM-2 proposed
// a fail-STALE in-memory cache; deferred for the MVP to avoid module-level mutable
// state, revisit at activation if real read-errors are observed.)
//
// TOCTOU: callers invoke shouldHoldProactiveWork() synchronously immediately
// before a synchronous sendPromptToSession (execFileSync). There is no await
// between the check and the inject, and the dashboard runs every injector on one
// JS thread, so the gate/inject pair is atomic (DA LOW, closed).
import { logger } from '../logger.js'
import { isFleetPaused } from './fleet-pause.js'

export type EnforcementMode = 'off' | 'dry-run' | 'enforce'

// Read the activation mode from the environment. Default and any unrecognised
// value resolve to 'off' so the fleet can NEVER start enforcing by accident.
export function readEnforcementMode(env: NodeJS.ProcessEnv = process.env): EnforcementMode {
  const v = (env.FLEET_PAUSE_ENFORCE ?? '').trim().toLowerCase()
  if (v === 'enforce') return 'enforce'
  if (v === 'dry-run') return 'dry-run'
  return 'off'
}

export interface EnforcementDecision {
  // hold = skip this proactive injection for now (it is retried after resume).
  hold: boolean
  // dryRun = enforce WOULD have held here; surfaced for logging only.
  dryRun: boolean
}

// Pure decision. off => inert; dry-run => flag-only; enforce => hold iff paused.
export function decideEnforcement(mode: EnforcementMode, paused: boolean): EnforcementDecision {
  if (mode === 'enforce') return { hold: paused, dryRun: false }
  if (mode === 'dry-run') return { hold: false, dryRun: paused }
  return { hold: false, dryRun: false }
}

export interface FleetPauseGateDeps {
  mode?: EnforcementMode
  isPaused?: (nowSec: number) => boolean
  nowSec?: () => number
  log?: (obj: object, msg: string) => void
}

// The wired gate. Returns true iff a proactive injection should be HELD this
// cycle. Callers use it as: `if (shouldHoldProactiveWork(label)) { skip/retry }`.
// `label` is a short identifier for the held work (audit/observability only).
export function shouldHoldProactiveWork(label: string, deps: FleetPauseGateDeps = {}): boolean {
  try {
    const mode = deps.mode ?? readEnforcementMode()
    // Inert fast-path: when off we do not even touch the sentinel -> zero cost,
    // zero behaviour change vs. the pre-enforcer build.
    if (mode === 'off') return false
    const now = (deps.nowSec ?? (() => Math.floor(Date.now() / 1000)))()
    const paused = (deps.isPaused ?? isFleetPaused)(now)
    const { hold, dryRun } = decideEnforcement(mode, paused)
    const log = deps.log ?? ((obj: object, msg: string) => logger.warn(obj, msg))
    if (dryRun) log({ label, mode, paused }, 'fleet-pause: DRY-RUN would hold proactive work (not enforcing)')
    if (hold) log({ label, mode, paused }, 'fleet-pause: HOLDING proactive work (enforce, fleet paused)')
    return hold
  } catch {
    return false // fail-OPEN
  }
}
