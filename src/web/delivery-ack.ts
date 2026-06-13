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
//   CLEAR: pane-ENGAGEMENT. An in-process observer (delivery-ack-observer.ts)
//     watches the recipient session and, when it transitions to BUSY after the
//     inject, appends a delivery-ack-cleared record for that id. The router only
//     injects into an IDLE pane (idle-only inject gate) and injects are
//     serialized in one process, so the first busy turn after inject IS the
//     receipt of OUR message -- a per-message-id receipt signal, NOT generic
//     activity inference. The earlier status='done' clear was RETRACTED (DA
//     review, card 1a99b7e2): a 2h delegation would false-escalate at 15 min,
//     because 'done' means completion, not receipt.
//   ESCALATE: pending records still OUTSTANDING (pending minus cleared) past the
//     window are escalated OUT OF BAND by a token-free bash-supervisor consumer
//     over direct HTTPS Bot-API (delivery-ack-cli.ts) -- the same d37df625
//     pipe-independent substrate, so a wedged dashboard cannot also mute the
//     escalation.
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
        typeof o.from === 'string' &&
        typeof o.to === 'string' &&
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

// ---------------------------------------------------------------------------
// CLEAR side (pane-engagement): the in-process observer appends one of these
// when it sees the recipient pane engage (go busy) after the inject. The file
// is APPEND-ONLY -- a clear is a new line, never a rewrite -- so the router's
// concurrent pending-ack appends and a torn final write are both safe.
// ---------------------------------------------------------------------------

export const DELIVERY_ACK_CLEARED_EVENT = 'delivery-ack-cleared'

/**
 * One JSON-object line recording that pending-ack `id` has been confirmed
 * received (recipient engaged). Pure (clock injected) so it is unit-testable;
 * the fs append lives in the observer.
 */
export function ackClearedRecord(id: number, clearedAtMs: number): string {
  return JSON.stringify({
    ts: new Date(clearedAtMs).toISOString(),
    event: DELIVERY_ACK_CLEARED_EVENT,
    id,
    cleared_at_ms: clearedAtMs,
  })
}

/**
 * Set of pending-ack ids that have a delivery-ack-cleared record in the
 * sentinel. Scans the same file the pending records live in. Blank / malformed
 * / wrong-event lines are skipped. Pure: takes the raw file text.
 */
export function parseClearedAckIds(raw: string): Set<number> {
  const out = new Set<number>()
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const o = JSON.parse(t)
      if (o && o.event === DELIVERY_ACK_CLEARED_EVENT && typeof o.id === 'number') {
        out.add(o.id)
      }
    } catch {
      // skip a malformed / partially-written line
    }
  }
  return out
}

/**
 * The pending acks still OUTSTANDING: every delivery-ack-pending record whose
 * id has no matching delivery-ack-cleared record. Deduped by id (ids are
 * unique, but a torn double-write must not double-count). This is the single
 * "still waiting on receipt" view both the clear observer and the escalation
 * consumer read. Pure: takes the raw file text.
 */
export function outstandingPendingAcks(raw: string): PendingAckEvent[] {
  const cleared = parseClearedAckIds(raw)
  const seen = new Set<number>()
  const out: PendingAckEvent[] = []
  for (const p of parsePendingAckSentinel(raw)) {
    if (cleared.has(p.id) || seen.has(p.id)) continue
    seen.add(p.id)
    out.push(p)
  }
  return out
}

/**
 * LOAD-BEARING INVARIANT (card 1a99b7e2, DA MUST-INCLUDE):
 *   The router injects an inter-agent message ONLY into a pane that
 *   isSessionReadyForPrompt reports IDLE (the idle-only inject gate in
 *   message-router.ts), and injects are serialized in a single synchronous
 *   injector (the dashboard process). The pane was therefore IDLE at inject.
 *   So a recipient pane observed BUSY on any later tick must have gone
 *   idle->busy AFTER our inject -> that busy turn is the receipt of OUR
 *   message, and clearing the pending-ack is correct.
 *
 *   If anyone later loosens the idle-only inject gate (delivering into a
 *   not-idle pane), this correlation BREAKS: an unrelated pre-existing turn
 *   could be mistaken for our receipt and clear the ack prematurely. Do not
 *   loosen that gate without revisiting this clear semantic.
 *
 * Returns the ids to clear: those whose recipient is currently engaged (busy).
 * `nowMs <= delivered_at_ms` is guarded so we never "observe before deliver"
 * (the observer always runs on a later tick, so this is belt-and-suspenders).
 * The busy check is injected as a predicate so this stays pure / testable.
 */
export function selectAcksToClear(
  outstanding: PendingAckEvent[],
  isRecipientBusy: (to: string) => boolean,
  nowMs: number,
): number[] {
  const ids: number[] = []
  for (const a of outstanding) {
    if (nowMs <= a.delivered_at_ms) continue
    if (isRecipientBusy(a.to)) ids.push(a.id)
  }
  return ids
}

// ---------------------------------------------------------------------------
// ESCALATE side: a token-free consumer (delivery-ack-cli.ts) reads the
// outstanding acks and escalates the ones overdue past the window, out of band
// over the d37df625 Telegram-fallback substrate. Mirrors the abandonment
// consumer's cursor/baseline machinery (delivery-sentinel-consumer.ts).
// ---------------------------------------------------------------------------

// The window after which an outstanding (unconfirmed) ack is considered overdue
// and escalated. 15 min: long enough that a real delegation turn has started
// (clearing the ack via engagement) yet short enough to turn a wedge/drop into
// a minutes-latency operator ping. The sampling-miss for a sub-poll-interval
// turn is an accepted trade-off (DA): ack_expected is opt-in for delegations,
// whose turns run minutes and are reliably caught by the 5s observer; a missed
// fast turn at worst yields one soft "verify receipt" ping, and the d37df625
// 1h-abandonment net remains the ultimate backstop.
export const ACK_ESCALATION_WINDOW_MS = 15 * 60 * 1000
const ACK_DEFAULT_MAX_PER_RUN = 25

export interface AckEscalationCursor {
  lastEscalatedId: number
}

export const EMPTY_ACK_CURSOR: AckEscalationCursor = { lastEscalatedId: 0 }

export interface AckEscalationPlan {
  /** Outstanding acks to escalate on this run, ascending by id. */
  escalations: PendingAckEvent[]
  /** Cursor to persist AFTER a successful escalation (or after a baseline). */
  nextCursor: AckEscalationCursor
  /** True when this run only baselined the cursor past existing outstanding
   * acks without escalating (first run on a non-empty trail). */
  baselined: boolean
}

export interface SelectAckEscalationOpts {
  /** Age past which an outstanding ack is overdue. Default 15 min. */
  windowMs?: number
  /** Max acks escalated in one run, to bound spam. Default 25. */
  maxPerRun?: number
  /** When true (default) and the cursor is initial on a non-empty trail, the
   * run BASELINES past all existing outstanding acks without sending, so a
   * deploy / a backlog written before the observer ran is not replayed. */
  baselineOnFirstRun?: boolean
}

function maxAckId(events: PendingAckEvent[], floor: number): number {
  let m = floor
  for (const e of events) {
    if (Number.isFinite(e.id) && e.id > m) m = e.id
  }
  return m
}

/**
 * Decide which outstanding acks to escalate, given the parsed outstanding set,
 * the persisted cursor and the clock. Pure: no IO.
 *
 *   - First run (cursor 0) on a NON-EMPTY outstanding set and baselineOnFirstRun:
 *     baseline only -- advance the cursor past all existing outstanding acks,
 *     escalate nothing (a deploy / pre-observer backlog must not replay).
 *   - Otherwise: escalate outstanding acks with id > cursor AND age >= windowMs,
 *     ascending, capped at maxPerRun; the cursor advances only THROUGH what is
 *     escalated so a capped remainder is retried next run and a failed send
 *     (caller does not persist the cursor) is retried.
 *
 * Non-finite ids (a torn row that slipped past parsing) are ignored.
 */
export function selectAckEscalations(
  outstanding: PendingAckEvent[],
  cursor: AckEscalationCursor,
  nowMs: number,
  opts: SelectAckEscalationOpts = {},
): AckEscalationPlan {
  const rawMax = opts.maxPerRun
  const maxPerRun = typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0
    ? Math.floor(rawMax)
    : ACK_DEFAULT_MAX_PER_RUN
  const windowMs = typeof opts.windowMs === 'number' && Number.isFinite(opts.windowMs) && opts.windowMs >= 0
    ? opts.windowMs
    : ACK_ESCALATION_WINDOW_MS
  const baselineOnFirstRun = opts.baselineOnFirstRun ?? true

  const valid = outstanding.filter((e) => Number.isFinite(e.id))

  // First run on a non-empty trail: baseline past ALL existing outstanding acks
  // (not just the overdue ones), so a recent-but-not-yet-overdue ack from before
  // the consumer existed is not later escalated against stale state.
  if (baselineOnFirstRun && cursor.lastEscalatedId === 0 && valid.length > 0) {
    return {
      escalations: [],
      nextCursor: { lastEscalatedId: maxAckId(valid, 0) },
      baselined: true,
    }
  }

  const fresh = valid
    .filter((e) => e.id > cursor.lastEscalatedId && nowMs - e.delivered_at_ms >= windowMs)
    .sort((a, b) => a.id - b.id)
  const escalations = fresh.slice(0, maxPerRun)
  const nextId = escalations.length
    ? escalations[escalations.length - 1]!.id
    : cursor.lastEscalatedId

  return {
    escalations,
    nextCursor: { lastEscalatedId: nextId },
    baselined: false,
  }
}

/**
 * Out-of-band Telegram fallback body for a batch of overdue acks. One line per
 * ack (id, parties). Worded as "receipt not confirmed" (not "dropped"): the
 * observer may have missed a sub-interval turn, so this is a verify-prompt, not
 * a definitive failure. Returns '' for an empty batch so the caller sends nothing.
 */
export function ackEscalationText(escalations: PendingAckEvent[]): string {
  if (escalations.length === 0) return ''
  const n = escalations.length
  const head =
    `⚠️ Delivery ACK overdue: ${n} ack-expected message${n === 1 ? '' : 's'} ` +
    `not confirmed received within 15 min (recipient never engaged after inject ` +
    `-- possible wedge/drop, or a very short turn the observer missed).`
  const lines = escalations.map((e) => `- #${e.id} ${e.from} -> ${e.to}`)
  const tail = 'Check the recipient session(s) and re-send if it still matters.'
  return [head, ...lines, tail].join('\n')
}
