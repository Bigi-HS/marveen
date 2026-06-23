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

// Priority-derived escalation timing (card 28d2179f, DA verdict on PR #130). The
// flat 60-min escalate-after let time-sensitive inter-agent messages (T3 triggers,
// deploy-GO, gate requests) sit silently for an hour. We now shout sooner for more
// urgent messages -- but ONLY the alert timing moves. The hard-TTL (true give-up)
// stays MESSAGE_HARD_TTL_MS for EVERY priority, so priority can never DROP a still-
// valid message earlier than before; it can only surface it earlier. The message
// priority comes from agent_messages.priority (same enum as kanban_cards).
export type MessagePriority = 'low' | 'normal' | 'high' | 'urgent'

const PRIORITY_ESCALATE_AFTER_MS: Record<MessagePriority, number> = {
  urgent: 15 * 60 * 1000,
  high: 30 * 60 * 1000,
  normal: MESSAGE_ESCALATE_AFTER_MS, // 60 min -- legacy behaviour
  low: MESSAGE_ESCALATE_AFTER_MS, // "low" is not "low latency" -- same as normal
}

/**
 * The retry thresholds for a message of the given priority. Unknown or undefined
 * priorities (e.g. a row from before the column existed) fall back to the default
 * 60-min behaviour. The re-alert interval mirrors escalate-after so a more urgent
 * message also re-nags more often; the hard-TTL is invariant across priorities.
 */
export function thresholdsForPriority(priority: MessagePriority | undefined | null): RetryThresholds {
  // `in`-guard rather than `(x && map[x]) || fallback`: the latter would also
  // fall back if a mapped value were ever 0 (Thor gate, PR #146). Membership is
  // explicit, so a future 0-valued threshold maps correctly and a bad DB string
  // still falls through to the default.
  const escalateAfterMs =
    priority != null && priority in PRIORITY_ESCALATE_AFTER_MS
      ? PRIORITY_ESCALATE_AFTER_MS[priority]
      : MESSAGE_ESCALATE_AFTER_MS
  return {
    escalateAfterMs,
    reAlertIntervalMs: escalateAfterMs,
    hardTtlMs: MESSAGE_HARD_TTL_MS,
  }
}

// Numeric rank for ordering the delivery drain: higher = delivered first.
// Mirrors the escalation enum (urgent most pressing). Unknown/undefined/null
// falls back to the `normal` rank, matching thresholdsForPriority's fallback.
const PRIORITY_RANK: Record<MessagePriority, number> = {
  urgent: 3,
  high: 2,
  normal: 1,
  low: 0,
}

/**
 * Delivery-order rank for a message priority (higher = drained first). Unknown
 * or missing priorities rank as `normal`, consistent with thresholdsForPriority.
 */
export function priorityRank(priority: MessagePriority | undefined | null): number {
  return priority != null && priority in PRIORITY_RANK
    ? PRIORITY_RANK[priority]
    : PRIORITY_RANK.normal
}

/**
 * Reorder a tick's pending messages so the router drains them by priority
 * (highest first), keeping strict FIFO (created_at ASC, then id ASC) WITHIN a
 * priority (card 83d9dde6, F1).
 *
 * The router still attempts every message every tick and an inject makes the
 * pane busy for the turn, so in practice only the first message targeting a
 * now-idle recipient is delivered per idle window. Draining FIFO meant a fresh
 * urgent update waited behind a recipient's stale low-priority backlog; ordering
 * by priority surfaces the most pressing message first. This is a PURE
 * reordering: it returns a new array, drops nothing, and does not change the
 * per-message escalate/hard-fail decision (classifyPendingMessage) or the
 * invariant hard-TTL -- it only changes WHICH still-valid message is offered
 * first when the recipient frees up. Ordering across different recipients is
 * irrelevant (independent panes), so a single global sort is correct.
 */
export function orderPendingByPriority<
  T extends { priority?: MessagePriority | null; created_at: number; id?: number },
>(messages: readonly T[]): T[] {
  return [...messages].sort((a, b) => {
    const byPriority = priorityRank(b.priority) - priorityRank(a.priority)
    if (byPriority !== 0) return byPriority
    if (a.created_at !== b.created_at) return a.created_at - b.created_at
    return (a.id ?? 0) - (b.id ?? 0)
  })
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
