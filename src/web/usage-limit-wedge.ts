// Pure decision core for usage-limit-modal auto-recovery of a wedged agent
// session (OPS: usage-limit modal wedge). The wedge: an agent's tmux session AND
// its MCP plugin child are both alive, but the Claude Code brain is frozen on the
// blocking usage-limit modal ("What do you want to do? / Stop and wait for limit
// to reset / Upgrade your plan"). The shared-account rolling limit trips whichever
// session is mid-request -- almost always the always-on high-frequency ones
// (marveen-channels, a busy sub-agent) -- and the modal is STICKY: it does not
// self-dismiss even after the limit resets, so the agent stays mute indefinitely
// while its inbound queues.
//
// Why this gap needs its own detector: channel-monitor's per-agent loop keys
// recovery on channel-plugin liveness (hasChannelPluginAlive), but the modal
// freezes the BRAIN while the plugin's bun child keeps running, so a wedged
// sub-agent lands in the "alive" branch and nothing acts; the bash *-watchdog.sh
// only relaunches on session DEATH (tmux has-session false), never on
// alive-but-wedged. This turns the liveness probe into a pane-content EFFECT
// probe -- the standing lesson of the usage-limit-modal incidents.
//
// This module is the PURE decision: the host loop (channel-monitor.ts) captures
// the agent pane, runs detectsUsageLimitMenu on it, and injects the resulting
// per-tick `modalDetected` boolean plus a clock; this returns whether to restart.
// Keeping it pure makes the confirm-window / cooldown / cap / escalation logic
// fully unit-testable without tmux. Mirrors the archetype in wedge-detector.ts.
//
// SAFETY -- the false-positive guard: detectsUsageLimitMenu is authoritative-narrow
// (its STRONG signal, the "Stop and wait for limit to reset" menu line, is UI
// chrome that cannot appear in natural reply prose), but a single capture frame
// can still glitch or catch a scrollback echo. So a restart fires ONLY after the
// modal is seen on >= confirmTicks CONSECUTIVE observations. A genuinely-active
// (non-stale) limit re-hits the modal on the fresh session, so a cooldown plus a
// restart cap bound the churn and escalate to the operator instead of looping.

/** Per-agent recovery bookkeeping. In-memory in the host loop. */
export interface UsageLimitWedgeState {
  /**
   * How many CONSECUTIVE observations the modal has been seen in the current
   * spell. Reset to 0 by any clear observation. The restart only arms once this
   * reaches confirmTicks, so a one-frame capture glitch never fires.
   */
  consecutiveModalTicks: number
  /** Epoch-ms of the last restart/escalate action, or null if none yet. */
  lastRestartAtMs: number | null
  /** How many restarts have fired in the current spell without the modal clearing. */
  restartCount: number
  /**
   * How many operator escalations have already fired for the current spell. Bounds
   * long-run alert spam: once the restart cap is hit, escalation repeats only up to
   * maxEscalations, then falls silent until the modal clears (which resets state).
   */
  escalationCount: number
}

export interface UsageLimitWedgeThresholds {
  /** Consecutive modal sightings required before the first restart (glitch guard). */
  confirmTicks: number
  /** Minimum gap (ms) between restart/escalate actions -- prevents restart-thrash. */
  cooldownMs: number
  /** After this many restarts that did NOT clear the modal, escalate to the operator. */
  maxRestarts: number
  /** Max operator escalations per spell before falling silent (bounds alert spam). */
  maxEscalations: number
}

/** 'recover' = restart the agent fresh; 'escalate' = operator alert (restart not fixing it); 'wait' = within cooldown; 'none' = no action. */
export type UsageLimitWedgeAction = 'recover' | 'escalate' | 'wait' | 'none'

export interface UsageLimitWedgeDecision {
  action: UsageLimitWedgeAction
  next: UsageLimitWedgeState
  reason: string
}

/**
 * Defaults tuned for a host loop that ticks about once a minute
 * (channel-monitor's ~60s cadence):
 * - confirmTicks 2: the modal must persist across two observations (~1-2 min) so
 *   a single glitch/scrollback frame is never acted on, while still recovering
 *   far faster than the 15-min keepalive-staleness fallback it replaces.
 * - cooldownMs 5 min: longer than a fresh session's cold boot (~15-80s) plus a
 *   re-confirm window, so one restart gets a fair chance before another fires.
 * - maxRestarts 3: if three fresh restarts do not clear it, the limit is not a
 *   stale sticky modal but a genuinely-active cap -> hand it to a human.
 * - maxEscalations 2: after the restart cap, alert the operator at most twice
 *   (spaced by the cooldown) then fall silent -- a modal a human has not yet
 *   cleared must not re-alert every cooldown forever.
 */
export const DEFAULT_USAGE_LIMIT_WEDGE_THRESHOLDS: UsageLimitWedgeThresholds = {
  confirmTicks: 2,
  cooldownMs: 5 * 60 * 1000,
  maxRestarts: 3,
  maxEscalations: 2,
}

const CLEAN_STATE: UsageLimitWedgeState = {
  consecutiveModalTicks: 0,
  lastRestartAtMs: null,
  restartCount: 0,
  escalationCount: 0,
}

/**
 * Decide whether to restart an agent wedged on the usage-limit modal.
 *
 * Order of checks (each can short-circuit):
 *  1. Modal not detected -> 'none' + reset to a clean spell (the wedge cleared, or
 *     there never was one). This re-arms the confirm window and alerting.
 *  2. Modal detected but the consecutive streak has not yet reached confirmTicks
 *     -> 'none', record the incremented streak only (glitch guard).
 *  3. Confirmed but within cooldown of the last action -> 'wait' (the streak still
 *     advances so we keep proving the modal is persisting).
 *  4. Confirmed, cooled down, restart cap already reached -> 'escalate' (a fresh
 *     restart is not clearing it) up to maxEscalations, then 'none' (silent).
 *  5. Otherwise -> 'recover' (restart the agent fresh).
 *
 * A future-dated lastRestartAtMs (clock skew / NTP correction) is treated as
 * cooldown-elapsed so the machine never stalls silently.
 */
export function decideUsageLimitRecovery(
  modalDetected: boolean,
  prev: UsageLimitWedgeState,
  nowMs: number,
  t: UsageLimitWedgeThresholds = DEFAULT_USAGE_LIMIT_WEDGE_THRESHOLDS,
): UsageLimitWedgeDecision {
  // 1. No modal -> the agent is not wedged (or has recovered). Reset the spell.
  if (!modalDetected) {
    return { action: 'none', next: { ...CLEAN_STATE }, reason: 'no usage-limit modal detected' }
  }

  const consecutiveModalTicks = prev.consecutiveModalTicks + 1

  // 2. Confirm window: a single (or sub-threshold) sighting only records; it never
  //    restarts. Guards against a one-frame capture glitch or a scrollback echo.
  if (consecutiveModalTicks < t.confirmTicks) {
    return {
      action: 'none',
      next: { ...prev, consecutiveModalTicks },
      reason: `modal seen ${consecutiveModalTicks}/${t.confirmTicks} consecutive ticks -- confirming`,
    }
  }

  // 3. Cooldown throttle. A future-dated stored timestamp (clock skew) counts as
  //    "cooled down" so the deltas never go negative and stall the machine.
  const withinCooldown =
    prev.lastRestartAtMs != null &&
    nowMs >= prev.lastRestartAtMs &&
    nowMs - prev.lastRestartAtMs < t.cooldownMs
  if (withinCooldown) {
    return {
      action: 'wait',
      next: { ...prev, consecutiveModalTicks },
      reason: 'confirmed modal but within restart cooldown',
    }
  }

  // 4. Restart cap: repeated fresh restarts that did not clear the modal mean the
  //    limit is genuinely active, not a stale sticky modal -> a human, not a loop.
  //    Escalate a BOUNDED number of times, spaced by the cooldown, then fall silent
  //    (the next clear observation, guard 1, re-arms alerting for a fresh spell).
  if (prev.restartCount >= t.maxRestarts) {
    if (prev.escalationCount >= t.maxEscalations) {
      return {
        action: 'none',
        next: { ...prev, consecutiveModalTicks },
        reason: `escalation cap reached (${prev.escalationCount}/${t.maxEscalations}) -- silent until the modal clears`,
      }
    }
    return {
      action: 'escalate',
      next: {
        ...prev,
        consecutiveModalTicks,
        lastRestartAtMs: nowMs,
        escalationCount: prev.escalationCount + 1,
      },
      reason: `${prev.restartCount} fresh restarts did not clear the modal -- operator needed (escalation ${prev.escalationCount + 1}/${t.maxEscalations})`,
    }
  }

  // 5. Fire a fresh restart.
  return {
    action: 'recover',
    next: {
      consecutiveModalTicks,
      lastRestartAtMs: nowMs,
      restartCount: prev.restartCount + 1,
      escalationCount: prev.escalationCount,
    },
    reason: 'usage-limit modal confirmed on a live-but-wedged session -- restarting fresh',
  }
}
