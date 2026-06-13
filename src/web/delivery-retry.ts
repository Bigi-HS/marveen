// Pure decision logic for the message-router's "busy recipient = defer, never
// drop" retry policy (card 7557a98d).
//
// THE BUG IT FIXES: the router used to markMessageFailed (drop) a message that
// could not be delivered within a single 60-min window. But a recipient pane is
// frequently just BUSY (a long turn), not dead -- most acutely the main agent,
// which can legitimately work >60 min. Dropping a still-valid message because
// its recipient is merely busy lost real inter-agent traffic (e.g. PR-status
// reports to marveen, 2026-06-13).
//
// THE POLICY: keep RETRYING delivery until a much longer HARD-TTL (6 h), the
// only true give-up. Meanwhile, surface the overdue delivery on a THROTTLED
// cadence -- first at 60 min, then ~hourly -- because a single escalation is too
// easily missed (the night-of-2026-06-13 ~10 h silence). The invariant shared
// with the heartbeat scheduler: a transient "busy" means DEFER, never DROP.
//
// Pure (clock + state injected) so it is unit-tested without tmux / the DB; the
// IO and the in-process escalation-state map live in message-router.ts.

export const MESSAGE_ESCALATE_AFTER_MS = 60 * 60 * 1000 // first overdue escalation
export const MESSAGE_REALERT_INTERVAL_MS = 60 * 60 * 1000 // re-nag cadence while still pending
export const MESSAGE_HARD_TTL_MS = 6 * 60 * 60 * 1000 // final give-up (markMessageFailed)

export interface RetryThresholds {
  escalateAfterMs: number
  reAlertIntervalMs: number
  hardTtlMs: number
}

export const DEFAULT_RETRY_THRESHOLDS: RetryThresholds = {
  escalateAfterMs: MESSAGE_ESCALATE_AFTER_MS,
  reAlertIntervalMs: MESSAGE_REALERT_INTERVAL_MS,
  hardTtlMs: MESSAGE_HARD_TTL_MS,
}

// What the router should do with one pending message this tick:
//   'wait'      -> still within a retry window; attempt delivery, do not escalate.
//   'escalate'  -> overdue and due for an alert; emit the escalation, then STILL
//                  attempt delivery (overdue does NOT skip the delivery attempt).
//   'hard-fail' -> past the hard-TTL; give up (markMessageFailed), do not deliver.
export type PendingAction = 'wait' | 'escalate' | 'hard-fail'

/**
 * Decide the action for one pending message.
 *
 * @param ageMs              now - created_at, in ms.
 * @param lastEscalatedAtMs  epoch-ms of the last escalation for this id, or
 *                           undefined if it has never been escalated.
 * @param nowMs             current epoch-ms (for the re-alert throttle).
 *
 * Note that only 'hard-fail' short-circuits delivery; 'wait' and 'escalate'
 * both fall through to a normal delivery attempt, so a recipient that frees up
 * even while overdue is delivered to immediately.
 */
export function classifyPendingMessage(
  ageMs: number,
  lastEscalatedAtMs: number | undefined,
  nowMs: number,
  t: RetryThresholds = DEFAULT_RETRY_THRESHOLDS,
): PendingAction {
  if (ageMs >= t.hardTtlMs) return 'hard-fail'
  if (ageMs < t.escalateAfterMs) return 'wait'
  // Overdue (escalateAfter <= age < hardTtl): escalate on first crossing, then
  // only once the re-alert interval has elapsed since the previous escalation.
  if (lastEscalatedAtMs === undefined) return 'escalate'
  if (nowMs - lastEscalatedAtMs >= t.reAlertIntervalMs) return 'escalate'
  return 'wait'
}

/**
 * Drop escalation-state entries whose id is no longer pending (delivered or
 * hard-failed), so the in-process map cannot grow without bound. Mutates the
 * map in place. Pure aside from that documented mutation.
 */
export function pruneEscalationState(
  state: Map<number, number>,
  pendingIds: Set<number>,
): void {
  for (const id of state.keys()) {
    if (!pendingIds.has(id)) state.delete(id)
  }
}
