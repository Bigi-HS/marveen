// NoA delivery core -- clean-room rewrite of the inter-agent delivery policy
// (umbrella f68461a6, block B1, first bounded PoC slice).
//
// WHAT THIS IS. The legacy message router interleaves its delivery decisions
// with IO (tmux probes, DB writes, sentinel appends) inside a single 5s tick
// loop, which makes the policy hard to test and easy to regress. This module
// inverts that structure: the ENTIRE per-tick decision is a pure function,
//
//   planDeliveryTick(input) -> DeliveryStep[]
//
// which consumes a snapshot of the world (pending messages, per-recipient
// pane state, throttle stamps, the clock) and returns an ordered plan of
// side-effect-free directives. A thin executor (follow-up slice) performs the
// IO for each step: inject the prompt, mark delivered/failed, append the
// overdue sentinel, run the quiescence proof. Policy changes then never touch
// IO code, and every invariant below is pinned by fast unit tests.
//
// LOAD-BEARING INVARIANTS (behaviour-compatible with the legacy layer; see
// store/spec-noa-b-orchestration-map.md, B1):
//
//   1. Busy recipient = DEFER, never DROP. A pane that is mid-turn is not
//      dead; a still-valid message retries until the hard-TTL, the only true
//      give-up.
//   2. The hard-TTL is invariant across priorities. Priority moves the alert
//      timing only (urgent 15 min, high 30 min, default 60 min); it can never
//      expire a message earlier.
//   3. Drain order: highest priority first, strict FIFO within a priority
//      (createdAtMs, then id). A fresh urgent must not wait behind a stale
//      low-priority backlog for the same recipient.
//   4. Idle-only inject: one delivery per recipient per tick. An inject makes
//      the pane busy for the turn, and the ACK protocol correlates "busy on a
//      later tick" with the receipt of OUR message -- so the planner never
//      schedules a second inject into the same idle window.
//   5. Quiescence backstop: a message stranded behind a PERSISTENT false
//      "not ready" reading may request an orthogonal idle proof, but only
//      once old enough (BACKSTOP_AFTER_MS) and at most once per message per
//      BACKSTOP_THROTTLE_MS -- and, stricter than the legacy router, at most
//      one probe per recipient per tick (the proof samples the pane for
//      ~1.2s; probing the same busy pane once per stranded message was pure
//      waste).
//   6. Escalation bookkeeping happens even when delivery is deferred: the
//      overdue trail must reach the out-of-band monitor precisely when the
//      recipient is unreachable.
//   7. A delivery hold (fleet pause) blocks proactive work only: injects and
//      pane probes stop, but hard-TTL expiry (bookkeeping, not proactive
//      work) still runs, and held rows simply stay pending.
//
// Everything here is deterministic: the clock, the pane snapshots and the
// throttle stamps are inputs, never ambient reads.

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

export type DeliveryTier = 'low' | 'normal' | 'high' | 'urgent'

/** A priority as it may appear in flight: the tier enum or a raw integer. */
export type DeliveryPriority = DeliveryTier | number

/**
 * Canonical weight per tier, strictly increasing with urgency so a plain
 * numeric comparison expresses "at least this urgent". The gaps leave room
 * for granular integer priorities between tiers.
 */
export const TIER_WEIGHT: Record<DeliveryTier, number> = {
  low: 25,
  normal: 50,
  high: 75,
  urgent: 100,
}

export const DEFAULT_WEIGHT = TIER_WEIGHT.normal

const TIER_NAMES: readonly DeliveryTier[] = ['low', 'normal', 'high', 'urgent']

function isTier(value: unknown): value is DeliveryTier {
  return typeof value === 'string' && (TIER_NAMES as readonly string[]).includes(value)
}

/**
 * Canonical weight for any priority representation. A tier maps via
 * TIER_WEIGHT; a finite number passes through unchanged (an off-tier integer
 * is honoured, not snapped, so granular priorities keep working); anything
 * else (unknown string, null, undefined, NaN, Infinity) falls back to the
 * normal default -- unknown priority behaves as normal.
 */
export function priorityWeight(value: DeliveryPriority | null | undefined): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : DEFAULT_WEIGHT
  }
  if (isTier(value)) return TIER_WEIGHT[value]
  return DEFAULT_WEIGHT
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS

/** First overdue escalation for normal/low/unknown priority. */
export const ESCALATE_AFTER_DEFAULT_MS = 60 * MINUTE_MS
/** First overdue escalation for high priority. */
export const ESCALATE_AFTER_HIGH_MS = 30 * MINUTE_MS
/** First overdue escalation for urgent priority. */
export const ESCALATE_AFTER_URGENT_MS = 15 * MINUTE_MS

/**
 * The final give-up, identical for every priority (invariant 2). Six hours:
 * long enough to ride out any legitimate long turn of a busy recipient,
 * short enough that a genuinely dead session does not hoard messages forever.
 */
export const HARD_TTL_MS = 6 * HOUR_MS

export interface RetryPolicy {
  /** Age at which the first overdue escalation fires. */
  escalateAfterMs: number
  /** Minimum gap between repeated escalations of the same message. */
  reAlertIntervalMs: number
  /** Age at which delivery is abandoned for real. */
  hardTtlMs: number
}

/**
 * The retry policy for a message of the given priority. The re-alert cadence
 * mirrors the escalate-after window (a more urgent message also re-nags more
 * often); the hard-TTL never varies. Numeric priorities bucket by the tier
 * thresholds (>= urgent weight, >= high weight, else default).
 */
export function retryPolicyFor(priority: DeliveryPriority | null | undefined): RetryPolicy {
  const w = priorityWeight(priority)
  const escalateAfterMs =
    w >= TIER_WEIGHT.urgent
      ? ESCALATE_AFTER_URGENT_MS
      : w >= TIER_WEIGHT.high
        ? ESCALATE_AFTER_HIGH_MS
        : ESCALATE_AFTER_DEFAULT_MS
  return { escalateAfterMs, reAlertIntervalMs: escalateAfterMs, hardTtlMs: HARD_TTL_MS }
}

// ---------------------------------------------------------------------------
// Age classification
// ---------------------------------------------------------------------------

/**
 * What a message's age means this tick:
 *   'wait'     -> inside a retry window (or recently nagged); just retry.
 *   'escalate' -> overdue and due for an (other) alert now.
 *   'expired'  -> past the hard-TTL; give up.
 */
export type AgeClass = 'wait' | 'escalate' | 'expired'

/**
 * Classify one message's age. Expiry takes precedence over escalation; an
 * overdue message escalates on the first crossing, then only once the
 * re-alert interval has elapsed since the previous escalation.
 */
export function classifyAge(
  ageMs: number,
  lastEscalatedAtMs: number | undefined,
  nowMs: number,
  policy: RetryPolicy,
): AgeClass {
  if (ageMs >= policy.hardTtlMs) return 'expired'
  if (ageMs < policy.escalateAfterMs) return 'wait'
  if (lastEscalatedAtMs === undefined) return 'escalate'
  return nowMs - lastEscalatedAtMs >= policy.reAlertIntervalMs ? 'escalate' : 'wait'
}

// ---------------------------------------------------------------------------
// Drain order
// ---------------------------------------------------------------------------

/**
 * Reorder a tick's pending messages for draining: highest priority first,
 * strict FIFO (createdAtMs, then id) within a priority (invariant 3). Pure --
 * returns a new array, drops nothing, decides nothing else.
 */
export function orderForDrain<
  T extends { priority?: DeliveryPriority | null; createdAtMs: number; id: number },
>(messages: readonly T[]): T[] {
  return [...messages].sort((a, b) => {
    const byPriority = priorityWeight(b.priority) - priorityWeight(a.priority)
    if (byPriority !== 0) return byPriority
    if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs
    return a.id - b.id
  })
}

// ---------------------------------------------------------------------------
// The tick planner
// ---------------------------------------------------------------------------

/** How long a message must have been pending before the quiescence backstop
 * may re-prove an apparently-busy pane. Kept well below the earliest
 * escalation window so a stranded message heals BEFORE it becomes alert
 * noise, and well above the tick cadence so a normally-busy recipient is not
 * pane-sampled continuously. */
export const BACKSTOP_AFTER_MS = 2 * MINUTE_MS

/** Minimum gap between two quiescence proofs for the same message. */
export const BACKSTOP_THROTTLE_MS = 1 * MINUTE_MS

/** One pending inter-agent message, as the planner sees it. */
export interface PendingDelivery {
  id: number
  from: string
  to: string
  priority?: DeliveryPriority | null
  /** Epoch-ms the message was created (the executor owns unit conversion). */
  createdAtMs: number
  /** Epoch-ms of the last recorded escalation for this message, if any. */
  lastEscalatedAtMs?: number
}

/** Snapshot of one recipient's session, captured by the executor pre-tick. */
export interface RecipientState {
  /** The recipient's terminal session exists and is running. */
  sessionRunning: boolean
  /** The readiness gate reports the pane idle and safe to inject into. */
  readyForPrompt: boolean
}

export interface DeliveryTickInput {
  nowMs: number
  pending: readonly PendingDelivery[]
  /** Recipient snapshots by agent id; a missing entry means no session. */
  recipients: ReadonlyMap<string, RecipientState>
  /** Epoch-ms of the last quiescence proof per message id (throttle state). */
  lastBackstopProbeAtMs?: ReadonlyMap<number, number>
  /**
   * Optional delivery hold (fleet pause). While it returns true for a
   * message, injects and pane probes for it stop; expiry still runs
   * (invariant 7). Must be deterministic for the tick.
   */
  holdDelivery?: (message: PendingDelivery) => boolean
  /** Test/tuning overrides; production uses the defaults. */
  backstopAfterMs?: number
  backstopThrottleMs?: number
}

export type DeferReason =
  | 'session-missing'
  | 'recipient-busy'
  | 'probe-throttled'
  | 'idle-window-consumed'
  | 'delivery-held'

/**
 * One directive for one pending message. `recordEscalation` asks the
 * executor to stamp the overdue trail (durable sentinel + last-escalated-at)
 * regardless of which action the message got (invariant 6).
 */
export type DeliveryStep =
  | { kind: 'expire'; id: number; to: string; ageMs: number }
  | { kind: 'deliver'; id: number; to: string; ageMs: number; recordEscalation: boolean }
  | { kind: 'backstop-probe'; id: number; to: string; ageMs: number; recordEscalation: boolean }
  | { kind: 'defer'; id: number; to: string; reason: DeferReason; recordEscalation: boolean }

/**
 * Plan one delivery tick. Emits exactly one step per pending message, in
 * drain order. The executor performs the steps sequentially in the returned
 * order on a single thread, which is what makes the planned idle windows
 * real: a 'deliver' step makes that pane busy, and the plan has already
 * deferred every later message aimed at it.
 *
 * For a 'backstop-probe' step the executor runs the orthogonal quiescence
 * proof and, only if the pane proves idle, delivers -- so the idle-only
 * inject invariant holds on that path too. Probe or not, the executor stamps
 * the probe time for the throttle.
 */
export function planDeliveryTick(input: DeliveryTickInput): DeliveryStep[] {
  const {
    nowMs,
    recipients,
    lastBackstopProbeAtMs,
    holdDelivery,
    backstopAfterMs = BACKSTOP_AFTER_MS,
    backstopThrottleMs = BACKSTOP_THROTTLE_MS,
  } = input

  const steps: DeliveryStep[] = []
  // Recipients whose idle window this plan has already consumed (a scheduled
  // deliver), and recipients already scheduled for a pane probe this tick.
  const windowConsumed = new Set<string>()
  const probeScheduled = new Set<string>()

  for (const message of orderForDrain(input.pending)) {
    const { id, to } = message
    const ageMs = nowMs - message.createdAtMs
    const policy = retryPolicyFor(message.priority)
    const age = classifyAge(ageMs, message.lastEscalatedAtMs, nowMs, policy)

    if (age === 'expired') {
      // Past the hard-TTL: give up for real, whatever the pane looks like.
      // No idle window is consumed -- nothing is injected.
      steps.push({ kind: 'expire', id, to, ageMs })
      continue
    }

    const recordEscalation = age === 'escalate'
    const defer = (reason: DeferReason): void => {
      steps.push({ kind: 'defer', id, to, reason, recordEscalation })
    }

    const recipient = recipients.get(to)
    if (!recipient?.sessionRunning) {
      defer('session-missing')
      continue
    }

    if (windowConsumed.has(to)) {
      defer('idle-window-consumed')
      continue
    }

    if (recipient.readyForPrompt) {
      if (holdDelivery?.(message)) {
        defer('delivery-held')
        continue
      }
      steps.push({ kind: 'deliver', id, to, ageMs, recordEscalation })
      windowConsumed.add(to)
      continue
    }

    // Busy pane. Old enough for the quiescence backstop?
    if (ageMs >= backstopAfterMs) {
      const lastProbe = lastBackstopProbeAtMs?.get(id)
      const messageThrottled = lastProbe !== undefined && nowMs - lastProbe < backstopThrottleMs
      if (messageThrottled || probeScheduled.has(to)) {
        defer('probe-throttled')
        continue
      }
      if (holdDelivery?.(message)) {
        defer('delivery-held')
        continue
      }
      steps.push({ kind: 'backstop-probe', id, to, ageMs, recordEscalation })
      probeScheduled.add(to)
      continue
    }

    // Too young for the backstop: a plain busy defer. The hold is not
    // consulted here -- no proactive action would have happened anyway, and
    // 'recipient-busy' is the more informative reason.
    defer('recipient-busy')
  }

  return steps
}

// ---------------------------------------------------------------------------
// Throttle-state hygiene
// ---------------------------------------------------------------------------

/**
 * Drop throttle-state entries whose message id is no longer pending
 * (delivered or expired), so the executor's in-process maps cannot grow
 * without bound. Mutates the map in place; that mutation is the point.
 */
export function pruneStaleThrottleState(
  state: Map<number, number>,
  pendingIds: ReadonlySet<number>,
): void {
  for (const id of state.keys()) {
    if (!pendingIds.has(id)) state.delete(id)
  }
}
