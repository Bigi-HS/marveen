// Pure decision core for OAuth login-wedge auto-recovery (card ba53fdee, SLICE 2).
//
// The wedge (08-04 fleet-dark, twice: 19 then 6 agents unseen): an agent's tmux
// session is ALIVE and its process RUNS, but the pane sits on an active OAuth
// /login box the agent cannot self-exit, so the brain processes nothing and every
// inbound delivery stalls silently. Session-presence liveness is blind to it
// (liveness != progress). SLICE 1 (PR#639) made it VISIBLE (log-only operator
// alert via detectsActiveLoginBox + decideSustainedPaneAlert); this module is the
// RECOVERY decision.
//
// Recovery root-cause (card's measured finding): `--continue` REPLAYS the stuck
// login-box UI state, so a --continue relaunch returns to the same prompt
// regardless of token validity. The fix is a FRESH relaunch that DROPS --continue
// (startAgentProcess(name, { fresh: true }), which also sources fleet-oauth-env in
// the spawned shell -- the relaunch PATH decides the 401, not the API call; a
// `POST /api/agents/<n>/restart` does NOT source it and stays 401). The host loop
// owns that I/O; this stays pure so the confirm/cooldown/cap/escalate logic and
// the two-stage gate are fully unit-testable without tmux or the DB.
//
// Structural sibling of decideUsageLimitRecovery (usage-limit-wedge.ts): both are
// pane-marker-driven recoveries of a frozen-brain-but-live-session wedge, gated by
// confirm-across-ticks + cooldown + restart-cap + bounded escalation. This one is
// kept SEPARATE (not an alias) for two reasons the fleet's per-wedge-shape modules
// already establish (usage-limit-wedge, wedge-detector, staged-wedge-probe are all
// purpose-built): (1) the input is a TWO-STAGE conjunction, not a single marker;
// (2) the recovery is DESTRUCTIVE of conversation context (drops --continue) where
// the usage-limit one preserves it -- a distinct semantics that warrants its own
// adversarial fixtures and reason strings.
//
// THE TWO-STAGE GATE -- the safety story. Dropping --continue destroys accumulated
// context, so a false-positive relaunch is costly. A relaunch therefore fires only
// when BOTH hold:
//   stage 1 (pane marker)  onLoginBox   -- detectsActiveLoginBox: the `Esc to
//                                           cancel` active-box signal in the pane
//                                           tail (NOT `Paste code here` in
//                                           scrollback, NOT a --continue-replayed
//                                           `Re-authenticate` in a HEALTHY session).
//   stage 2 (effect probe) inboxStuck   -- an overdue pending inbound is NOT
//                                           draining, proving the brain is
//                                           genuinely frozen rather than merely
//                                           showing a login string while it keeps
//                                           processing.
// If the marker is present but the inbox is DRAINING (inboxStuck=false), the brain
// is demonstrably live -> treat it as NOT wedged and reset the spell. This kills
// the scrollback / --continue-replay false-positive class outright.
//
// Trade-off (documented, intentional): a login-wedged agent with an EMPTY inbox
// (no starved work) will NOT be auto-recovered here -- stage 2 is unmet. That is
// deliberate: with no delivery being starved there is nothing to justify a
// context-dropping relaunch, and SLICE 1's sustained alert still notifies the
// operator for a manual recovery. Auto-recovery is reserved for the case where
// real work is provably stuck.

/** The two per-agent signals the host loop gathers and injects each tick. */
export interface LoginWedgeSignal {
  /** Stage 1: detectsActiveLoginBox(pane) -- the active OAuth login-box pane marker. */
  onLoginBox: boolean
  /**
   * Stage 2 (effect probe): is an overdue pending inbound NOT draining? True means
   * the inbox is backing up (brain frozen); false means the queue is draining (the
   * agent is processing despite any login string in the pane) OR there is nothing
   * pending. Only true corroborates a genuine freeze.
   */
  inboxStuck: boolean
}

/** Per-agent recovery bookkeeping. In-memory in the host loop. */
export interface LoginWedgeRecoveryState {
  /**
   * Consecutive observations the two-stage wedge condition has held in the current
   * spell. Reset to 0 by any observation that is not a confirmed wedge, so a single
   * capture glitch or a transient one-tick reauth never fires a relaunch.
   */
  consecutiveWedgeTicks: number
  /** Epoch-ms of the last relaunch/escalation action, or null if none yet. */
  lastActionAtMs: number | null
  /** How many fresh relaunches have fired in the current spell without it clearing. */
  relaunchCount: number
  /** How many operator escalations have already fired for the current spell. */
  escalationCount: number
}

export interface LoginWedgeRecoveryThresholds {
  /** Consecutive confirmed-wedge sightings required before the first relaunch (glitch guard). */
  confirmTicks: number
  /** Minimum gap (ms) between relaunch/escalate actions -- prevents relaunch-thrash. */
  cooldownMs: number
  /** After this many fresh relaunches that did NOT clear the wedge, escalate to the operator. */
  maxRelaunches: number
  /** Max operator escalations per spell before falling silent (bounds alert spam). */
  maxEscalations: number
}

/** 'recover' = fresh relaunch (drop --continue); 'escalate' = operator alert; 'wait' = within cooldown; 'none' = no action. */
export type LoginWedgeAction = 'recover' | 'escalate' | 'wait' | 'none'

export interface LoginWedgeRecoveryDecision {
  action: LoginWedgeAction
  next: LoginWedgeRecoveryState
  reason: string
}

/**
 * Defaults tuned for the channel-monitor per-agent scan (~60s cadence), mirroring
 * decideUsageLimitRecovery so the two frozen-brain recoveries behave consistently:
 * - confirmTicks 2: the two-stage wedge must persist across two observations
 *   (~1-2 min) so no single glitch/scrollback frame is acted on.
 * - cooldownMs 5 min: longer than a fresh session's cold boot + a re-confirm
 *   window, so one relaunch gets a fair chance before another fires.
 * - maxRelaunches 3: if three fresh relaunches keep returning to the login box the
 *   credential itself is dead (not a stale UI) -> hand it to a human.
 * - maxEscalations 2: after the relaunch cap, alert at most twice (spaced by the
 *   cooldown) then fall silent until the wedge clears (which resets the spell).
 */
export const DEFAULT_LOGIN_WEDGE_RECOVERY_THRESHOLDS: LoginWedgeRecoveryThresholds = {
  confirmTicks: 2,
  cooldownMs: 5 * 60 * 1000,
  maxRelaunches: 3,
  maxEscalations: 2,
}

const CLEAN_STATE: LoginWedgeRecoveryState = {
  consecutiveWedgeTicks: 0,
  lastActionAtMs: null,
  relaunchCount: 0,
  escalationCount: 0,
}

/**
 * Decide whether to fire a fresh relaunch for an agent wedged on an active OAuth
 * login box.
 *
 * Order of checks (each can short-circuit):
 *  1. Two-stage gate unmet (no login box, OR box present but inbox draining) ->
 *     'none' + reset the spell. The draining-inbox branch is the key false-positive
 *     kill: a login string with a live, draining brain is not a wedge.
 *  2. Confirmed wedge but the consecutive streak is below confirmTicks -> 'none',
 *     record the incremented streak only (glitch guard).
 *  3. Confirmed, within cooldown of the last action -> 'wait' (streak still advances
 *     so we keep proving the wedge persists).
 *  4. Confirmed, cooled down, relaunch cap already reached -> 'escalate' up to
 *     maxEscalations, then 'none' (silent until it clears).
 *  5. Otherwise -> 'recover' (fresh relaunch).
 *
 * A future-dated lastActionAtMs (clock skew / NTP correction) is treated as
 * cooldown-elapsed so the machine never stalls silently.
 */
export function decideLoginWedgeRecovery(
  signal: LoginWedgeSignal,
  prev: LoginWedgeRecoveryState,
  nowMs: number,
  t: LoginWedgeRecoveryThresholds = DEFAULT_LOGIN_WEDGE_RECOVERY_THRESHOLDS,
): LoginWedgeRecoveryDecision {
  // 1. Two-stage confirmation. The wedge counts as present ONLY when the pane
  //    marker AND the effect probe agree. Anything else resets the spell.
  const wedgeConfirmed = signal.onLoginBox && signal.inboxStuck
  if (!wedgeConfirmed) {
    const reason = !signal.onLoginBox
      ? 'no active login box detected'
      : 'login marker present but inbox draining -- brain live, not wedged (scrollback/replay guard)'
    return { action: 'none', next: { ...CLEAN_STATE }, reason }
  }

  const consecutiveWedgeTicks = prev.consecutiveWedgeTicks + 1

  // 2. Confirm window: a sub-threshold streak only records; it never relaunches.
  if (consecutiveWedgeTicks < t.confirmTicks) {
    return {
      action: 'none',
      next: { ...prev, consecutiveWedgeTicks },
      reason: `login wedge seen ${consecutiveWedgeTicks}/${t.confirmTicks} consecutive ticks -- confirming`,
    }
  }

  // 3. Cooldown throttle. A future-dated stored timestamp (clock skew) counts as
  //    "cooled down" so the deltas never go negative and stall the machine.
  const withinCooldown =
    prev.lastActionAtMs != null &&
    nowMs >= prev.lastActionAtMs &&
    nowMs - prev.lastActionAtMs < t.cooldownMs
  if (withinCooldown) {
    return {
      action: 'wait',
      next: { ...prev, consecutiveWedgeTicks },
      reason: 'confirmed login wedge but within relaunch cooldown',
    }
  }

  // 4. Relaunch cap: repeated fresh relaunches that keep returning to the login box
  //    mean the credential itself is dead, not a stale UI -> a human, not a loop.
  //    Escalate a BOUNDED number of times, then fall silent (guard 1 re-arms on the
  //    next clear observation).
  if (prev.relaunchCount >= t.maxRelaunches) {
    if (prev.escalationCount >= t.maxEscalations) {
      return {
        action: 'none',
        next: { ...prev, consecutiveWedgeTicks },
        reason: `escalation cap reached (${prev.escalationCount}/${t.maxEscalations}) -- silent until the login wedge clears`,
      }
    }
    return {
      action: 'escalate',
      next: {
        ...prev,
        consecutiveWedgeTicks,
        lastActionAtMs: nowMs,
        escalationCount: prev.escalationCount + 1,
      },
      reason: `${prev.relaunchCount} fresh relaunches did not clear the login box -- credential likely dead, operator needed (escalation ${prev.escalationCount + 1}/${t.maxEscalations})`,
    }
  }

  // 5. Fire a fresh relaunch (drop --continue).
  return {
    action: 'recover',
    next: {
      consecutiveWedgeTicks,
      lastActionAtMs: nowMs,
      relaunchCount: prev.relaunchCount + 1,
      escalationCount: prev.escalationCount,
    },
    reason: 'active login box + stuck inbox confirmed on a live-but-frozen session -- fresh relaunch (drop --continue)',
  }
}
