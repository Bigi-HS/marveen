// Pure decision core for the staged-input-wedge auto-recovery (card c88bc682 /
// OPS-007). The wedge: an agent's tmux session is alive and its watchdog is up,
// but a heartbeat/task prompt sits un-submitted in the composer and its
// inter-agent inbox stops draining (delivered_at stays NULL for hours) -- while
// the agent still emits SOME outbound. The existing fixes do NOT cover it:
// c8d13cc0 (ghost-text server-side) and 1b0f58ba (paste-placeholder recovery)
// only handle a `[Pasted text #N]` placeholder, not a composed task prompt that
// is stuck while the inbox backs up. Confirmed 3x in 24h (forge 08-01, gyore
// 08-02, scout 08-02), each needing a manual kill-session -> watchdog respawn.
//
// This module is the PURE decision -- it takes a snapshot of an agent's signals
// (all facts injected, clock injected) and returns whether to fire a
// context-preserving restart. The I/O (querying the DB, calling
// restartAgentProcess) lives in the host loop; keeping the decision pure makes
// the adversarial FP/FN cases fully unit-testable without tmux or the DB.
//
// SAFETY -- the critical false-positive guard: recovery fires ONLY when the
// agent is ALIVE (recent outbound) but its inbox is stuck. An agent with an old
// pending inbox and NO recent outbound is a crashed/idle agent, which is normal
// watchdog territory, NOT this wedge -- restarting it here would be redundant at
// best and could interrupt a legitimate long-running turn at worst.

/**
 * A snapshot of one agent's wedge-relevant state, computed by the host loop from
 * the agent_messages table (noa.db) plus any delivery-monitor abandon event seen
 * this cycle. All ages are in whole minutes so the thresholds read naturally.
 */
export interface WedgeSignal {
  /** Is there at least one inbound message to this agent with delivered_at NULL? */
  hasPendingInbound: boolean
  /** Age (minutes) of the OLDEST pending (delivered_at NULL) inbound message. 0 when none. */
  oldestPendingAgeMin: number
  /**
   * Minutes since this agent's most recent OUTBOUND message (from_agent = agent).
   * null when the agent has produced no outbound in the observed window -- which,
   * combined with a stuck inbox, means "not alive-but-stuck" (see safety note).
   */
  lastOutboundAgeMin: number | null
  /**
   * A delivery-monitor hard-TTL abandon (message TO this agent given up after
   * MESSAGE_HARD_TTL_MS = 360 min) was recorded this cycle. The strongest wedge
   * entry-signal, but still gated by the recent-outbound guard so a genuinely
   * dead recipient is not auto-restarted.
   */
  sawAbandonEvent: boolean
}

/** Per-agent recovery bookkeeping. In-memory in the host; may be persisted later. */
export interface WedgeRecoveryState {
  /** Epoch-ms of the last recovery/escalation action, or null if none yet. */
  lastActionAtMs: number | null
  /** How many consecutive recoveries have fired without the inbox recovering. */
  recoveryCount: number
  /**
   * How many operator escalations have already fired for the CURRENT incident.
   * Bounds long-run alert spam: once the recovery cap is hit, escalation repeats
   * only up to maxEscalations, then falls silent until the incident clears
   * (guard 1 reset). Absent on legacy state -> treated as 0.
   */
  escalationCount?: number
}

export interface WedgeThresholds {
  /** Oldest pending inbound must be at least this old (minutes) to count as wedged. */
  overdueMins: number
  /** Last outbound must be within this window (minutes) to prove the agent is alive-but-stuck. */
  outboundRecentMins: number
  /** Minimum gap (ms) between recovery/escalation actions -- prevents restart-thrash. */
  cooldownMs: number
  /** After this many consecutive recoveries that did NOT fix it, escalate to the operator instead. */
  maxRecoveries: number
  /** Max operator escalations per incident before falling silent (bounds alert spam). */
  maxEscalations: number
}

/** 'recover' = context-preserving restart; 'escalate' = operator alert (restart not fixing it); 'wait' = cooldown; 'none' = no wedge. */
export type WedgeAction = 'recover' | 'escalate' | 'wait' | 'none'

export interface WedgeDecision {
  action: WedgeAction
  next: WedgeRecoveryState
  reason: string
}

/**
 * Defaults chosen from the incident data (forge/gyore/scout, 08-01..02):
 * - overdueMins 40: shorter than the 360-min hard-TTL so we catch the wedge long
 *   before the message is abandoned, but long enough that a merely-busy agent
 *   (transient) is not mistaken for wedged.
 * - outboundRecentMins 60: the wedged agents kept emitting scheduled outbound
 *   within the hour while their inbox stalled; a >60-min outbound silence with a
 *   stuck inbox reads as a dead agent, not this wedge.
 * - cooldownMs 45 min: longer than one overdue window so a single restart gets a
 *   fair chance to drain the inbox before another fires.
 * - maxRecoveries 3: if three context-preserving restarts do not clear it, the
 *   problem is not a transient stdio wedge -> hand it to a human.
 * - maxEscalations 2: after the recovery cap, alert the operator at most twice
 *   (spaced by the cooldown) then fall silent -- a wedge a human has not yet
 *   cleared must not re-alert every cooldown forever (DA flag, card c88bc682).
 */
export const DEFAULT_WEDGE_THRESHOLDS: WedgeThresholds = {
  overdueMins: 40,
  outboundRecentMins: 60,
  cooldownMs: 45 * 60 * 1000,
  maxRecoveries: 3,
  maxEscalations: 2,
}

const CLEAN_STATE: WedgeRecoveryState = { lastActionAtMs: null, recoveryCount: 0, escalationCount: 0 }

/**
 * Decide whether to fire a context-preserving restart for a wedged agent.
 *
 * Order of checks (each is a guard that can short-circuit):
 *  1. Inbox healthy (nothing pending) -> 'none' + reset state (the agent recovered).
 *  2. Pending but not yet overdue and no abandon event -> 'none', state preserved.
 *  3. Wedge symptom present BUT no recent outbound -> 'none' (dead/idle agent =
 *     watchdog territory, NOT this wedge). This is the key false-positive guard.
 *  4. Within cooldown of the last action -> 'wait' (throttles both recover and escalate).
 *  5. Recovery cap already reached -> 'escalate' (restart is not fixing it),
 *     but only up to maxEscalations times per incident, then 'none' (silent).
 *  6. Otherwise -> 'recover'.
 */
export function decideWedgeRecovery(
  signal: WedgeSignal,
  prev: WedgeRecoveryState,
  nowMs: number,
  t: WedgeThresholds = DEFAULT_WEDGE_THRESHOLDS,
): WedgeDecision {
  // 1. A drained/empty inbox means the agent is consuming its queue -> healthy.
  //    Reset the spell so the next wedge starts from a clean slate.
  if (!signal.hasPendingInbound && !signal.sawAbandonEvent) {
    return { action: 'none', next: { ...CLEAN_STATE }, reason: 'inbox draining/empty -- healthy' }
  }

  // 2. Pending exists but is not yet old enough, and no hard-TTL abandon -> not
  //    (yet) a wedge. Preserve state (a wedge may still be forming).
  const overduePending = signal.hasPendingInbound && signal.oldestPendingAgeMin >= t.overdueMins
  const wedgeSymptom = overduePending || signal.sawAbandonEvent
  if (!wedgeSymptom) {
    return { action: 'none', next: prev, reason: 'pending but below overdue threshold' }
  }

  // 3. CRITICAL FALSE-POSITIVE GUARD: only an alive-but-stuck agent gets this
  //    recovery. No recent outbound + stuck inbox = crashed/idle agent, which the
  //    watchdog/relaunch path owns -- never auto-restart it from here.
  const recentOutbound =
    signal.lastOutboundAgeMin != null && signal.lastOutboundAgeMin <= t.outboundRecentMins
  if (!recentOutbound) {
    return {
      action: 'none',
      next: prev,
      reason: 'wedge symptom but no recent outbound -- dead/idle agent, watchdog territory (not staged-input wedge)',
    }
  }

  // 4. Cooldown throttle (applies to both recover and escalate) -- prevents
  //    restart-thrash and escalation spam.
  if (prev.lastActionAtMs != null && nowMs - prev.lastActionAtMs < t.cooldownMs) {
    return { action: 'wait', next: prev, reason: 'within recovery cooldown' }
  }

  // 5. Recovery cap: repeated restarts that did not clear it -> a human, not a loop.
  //    Escalate a BOUNDED number of times (maxEscalations), spaced by the cooldown,
  //    then fall silent -- a wedge the operator has not yet cleared must NOT re-alert
  //    every cooldown forever (DA flag, card c88bc682). The next inbox drain (guard 1)
  //    resets the spell and re-arms alerting for a fresh incident.
  if (prev.recoveryCount >= t.maxRecoveries) {
    const escalationCount = prev.escalationCount ?? 0
    if (escalationCount >= t.maxEscalations) {
      return {
        action: 'none',
        next: prev,
        reason: `escalation cap reached (${escalationCount}/${t.maxEscalations}) -- silent until the incident clears (operator already notified)`,
      }
    }
    return {
      action: 'escalate',
      next: { lastActionAtMs: nowMs, recoveryCount: prev.recoveryCount, escalationCount: escalationCount + 1 },
      reason: `restart did not clear the wedge after ${prev.recoveryCount} attempts -- operator needed (escalation ${escalationCount + 1}/${t.maxEscalations})`,
    }
  }

  // 6. Fire the context-preserving restart.
  return {
    action: 'recover',
    next: { lastActionAtMs: nowMs, recoveryCount: prev.recoveryCount + 1, escalationCount: prev.escalationCount ?? 0 },
    reason: 'staged-input wedge: overdue pending inbox + recent outbound (alive-but-stuck)',
  }
}
