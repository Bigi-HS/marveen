// Pending-ACK substrate for the delivery ACK protocol (card 1a99b7e2).
//
// Today "delivered" only means sendPromptToSession did not throw -- a positive
// ASSUMPTION. A session that is wedged or silently ignores the injected prompt
// still counts as delivered, and the only net is the d37df625 1h-abandonment
// trail. The ACK protocol adds a tighter positive-CONFIRMATION net for the
// messages that warrant it:
//
//   WRITE (this module + the router): on a successful inject of an ACK-EXPECTED
//     message, append a pending-ack record to the sentinel below.
//   CLEAR: the message reaching status='done' (completed_at) via the EXISTING
//     PATCH /api/messages/:id endpoint -- a per-message-id, recipient-specific
//     signal (NOT generic activity inference, which a heartbeat / concurrent
//     sender / unrelated work would false-clear; DA review, card 1a99b7e2).
//   ESCALATE: overdue-unacked records are escalated OUT OF BAND by the
//     d37df625 bash-supervisor consumer over direct HTTPS Bot-API -- the same
//     pipe-independent substrate, shared so there is one channel, not two.
//
// SCOPE GATE (DA rollout finding): only ACK-EXPECTED messages are tracked.
// `ack_expected` is opt-in per message (a delegation that already marks 'done'
// by convention, or any sender that wants the 15-min net, e.g. a gate request).
// Plain FYI peer messages set nothing -> no record -> best-effort, so an agent
// that never marks-done cannot generate a constant 15-min false escalation
// (cry-wolf). Those FYIs are still backstopped by the d37df625 1h net, so the
// narrower scope leaves NO silent-drop gap.
//
// Dependency-free so it is unit-testable without the DB / fs / tmux.

// Durable, delivery-independent pending-ack trail. Lives under the gitignored
// store/; the d37df625 supervisor consumer tails it (shared substrate).
export const DELIVERY_PENDING_ACK_SENTINEL = 'store/.delivery-pending-ack.jsonl'

// The router needs only these fields to decide + record an ack. `ack_expected`
// is the unified capability gate: there is no separate per-message delegation
// flag (delegatesTo is a team-graph relation, not a message field), so a
// delegating sender expresses "I expect an ACK" by setting this.
export interface AckCapableMessage {
  id: number
  from_agent: string
  to_agent: string
  ack_expected?: boolean | number | null
}

/**
 * Whether a successfully-injected message should get a pending-ack record.
 * True only when the sender opted in via ack_expected (truthy). Accepts the
 * boolean or the SQLite 0/1 integer form transparently.
 */
export function shouldWritePendingAck(msg: AckCapableMessage): boolean {
  return !!msg.ack_expected
}

/**
 * One JSON-object line describing a pending ack for the sentinel file. Pure
 * (clock injected) so it is unit-testable; the fs append lives in the router.
 * Mirrors delivery-alert.ts's abandonmentRecord shape so the supervisor
 * consumer parses both trails with the same machinery.
 */
export function pendingAckRecord(
  msg: { id: number; from_agent: string; to_agent: string },
  deliveredAtMs: number,
): string {
  return JSON.stringify({
    ts: new Date(deliveredAtMs).toISOString(),
    event: 'delivery-ack-pending',
    id: msg.id,
    from: msg.from_agent,
    to: msg.to_agent,
    delivered_at_ms: deliveredAtMs,
  })
}

export interface PendingAckEvent {
  ts: string
  event: string
  id: number
  from: string
  to: string
  delivered_at_ms: number
}

/**
 * Parse the pending-ack sentinel (one JSON object per line, as written by
 * pendingAckRecord) into PendingAckEvent records. Blank lines, malformed JSON
 * and non-"delivery-ack-pending" rows are skipped so a torn final write or a
 * hand-edit never throws. Pure: takes the raw file text.
 */
export function parsePendingAckSentinel(raw: string): PendingAckEvent[] {
  const out: PendingAckEvent[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const o = JSON.parse(t)
      if (
        o &&
        o.event === 'delivery-ack-pending' &&
        typeof o.ts === 'string' &&
        typeof o.id === 'number' &&
        typeof o.delivered_at_ms === 'number'
      ) {
        out.push(o as PendingAckEvent)
      }
    } catch {
      // skip a malformed / partially-written line
    }
  }
  return out
}
