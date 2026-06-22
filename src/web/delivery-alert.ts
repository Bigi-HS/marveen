// Pure helpers for the message-router's "never drop silently" guard
// (card d3339db9). When an inter-agent message is abandoned after the
// retry window, the router enqueues an alert to the main agent so a
// delivery failure is always surfaced -- even if a future pane-detector
// gap re-introduces a false-busy. Kept dependency-free so it is
// unit-testable without tmux or the DB.

// Sender id for delivery-monitor alerts. A CODE CONSTANT, never a real
// agent: it exists only so the recursion guard can recognise the router's
// own alerts and not alert about an alert.
export const DELIVERY_MONITOR_AGENT_ID = 'delivery-monitor'

/**
 * Should an abandoned inter-agent message spawn a delivery-dropped alert
 * to the main agent? True for ordinary messages; false when the abandoned
 * message is itself a delivery-monitor alert (recursion guard: if the main
 * agent is unreachable for the whole window, one dropped alert must not
 * cascade into an unbounded chain of alerts-about-alerts).
 */
export function shouldAlertOnAbandon(fromAgent: string): boolean {
  return fromAgent !== DELIVERY_MONITOR_AGENT_ID
}

// An abandonment has two phases (card 7557a98d). 'overdue': the message is still
// pending and the router keeps retrying (recipient merely busy). 'dropped': the
// hard-TTL was reached and the message was given up on for real. Both are
// recorded in the durable sentinel; they differ in whether they warrant a
// Boss-facing in-band alert -- see alertInBand.
export type AbandonmentPhase = 'overdue' | 'dropped'

/**
 * Should this abandonment phase raise a Boss-facing in-band alert (an
 * inter-agent message to the main agent)? Only 'dropped' does -- a permanent
 * give-up the operator may need to act on (card f1ea52c0 / Boss 2026-06-22:
 * the 'overdue' "still retrying" nag was noise, since the router delivers the
 * message as soon as the busy recipient frees up and the durable sentinel
 * already records it out-of-band). 'overdue' is therefore sentinel-only. The
 * recursion guard (an abandoned monitor alert must not spawn another) still
 * applies via shouldAlertOnAbandon.
 */
export function alertInBand(phase: AbandonmentPhase, fromAgent: string): boolean {
  return phase === 'dropped' && shouldAlertOnAbandon(fromAgent)
}

/**
 * Human-readable alert body for a dropped (permanently abandoned) inter-agent
 * message. Names the id, the parties, and the age so the main agent can
 * investigate the target's session, and states plainly the message was NOT
 * delivered (the d3339db9 pain was that the drop was invisible). Only the
 * 'dropped' phase is alerted in-band (see alertInBand), so this no longer
 * branches on phase.
 */
export function abandonAlertContent(
  msg: { id: number; from_agent: string; to_agent: string },
  ageMs: number,
): string {
  const mins = Math.round(ageMs / 60000)
  return (
    `DELIVERY DROPPED: inter-agent message #${msg.id} from "${msg.from_agent}" ` +
    `to "${msg.to_agent}" was abandoned after ${mins} min (target session never ` +
    `became ready for a prompt). The message was NOT delivered. Check ` +
    `"${msg.to_agent}"'s session health and re-send if it still matters.`
  )
}

// Durable, delivery-independent sentinel for abandoned messages (PR #130 DA
// review, MEDIUM). The inter-agent alert above is itself an inter-agent
// message, so it can also go undelivered -- most acutely when the abandoned
// message's recipient IS the wedged main agent, leaving the "never drop
// silently" net silent. Every abandonment is ALSO appended as one JSONL line
// to this file (under the gitignored store/), which a token-free always-on
// watcher (fleet-supervisor) can tail and escalate out-of-band.
export const DELIVERY_ABANDONMENT_SENTINEL = 'store/.delivery-abandonment-alerts.jsonl'

/**
 * One JSON-object line describing an abandoned-message event for the sentinel
 * file. Pure (clock injected) so it is unit-testable; the fs append lives in
 * the router. Unlike abandonAlertContent this is emitted for EVERY abandonment
 * -- including an abandoned monitor alert -- because the durable trail is the
 * last line of defence and must capture exactly the "alert itself was lost"
 * case.
 */
export function abandonmentRecord(
  msg: { id: number; from_agent: string; to_agent: string },
  ageMs: number,
  nowMs: number,
  phase: AbandonmentPhase = 'dropped',
): string {
  return JSON.stringify({
    ts: new Date(nowMs).toISOString(),
    event: 'delivery-abandoned',
    id: msg.id,
    from: msg.from_agent,
    to: msg.to_agent,
    age_min: Math.round(ageMs / 60000),
    phase,
  })
}

// One parsed delivery-abandoned event from the sentinel file.
export interface AbandonmentEvent {
  ts: string
  event: string
  id: number
  from: string
  to: string
  age_min: number
  // 'overdue' (still retrying) or 'dropped' (hard-TTL give-up). Rows written
  // before card 7557a98d have no phase field and are read as 'dropped'.
  phase: AbandonmentPhase
}

/**
 * Parse the delivery-abandonment sentinel (one JSON object per line, as written
 * by abandonmentRecord) into AbandonmentEvent records. Blank lines, malformed
 * JSON and non-"delivery-abandoned" rows are skipped, so a torn final write or
 * a hand-edit never throws. Pure: takes the raw file text.
 */
export function parseAbandonmentSentinel(raw: string): AbandonmentEvent[] {
  const out: AbandonmentEvent[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const o = JSON.parse(t)
      if (o && o.event === 'delivery-abandoned' && typeof o.ts === 'string') {
        out.push({ ...o, phase: o.phase === 'overdue' ? 'overdue' : 'dropped' } as AbandonmentEvent)
      }
    } catch {
      // skip a malformed / partially-written line
    }
  }
  return out
}

/**
 * Cap an append-only JSONL trail to its most recent `maxLines` records (card
 * 681f99b0 / A2). The abandonment trail accumulates one row per abandonment plus
 * per throttled re-alert and -- unlike the pending-ack trail -- has no fold
 * collapse (every row is a distinct historical event), so its only bound is a
 * size cap. Keeps the NEWEST rows (the consumer cursors by per-id ts, so dropped
 * older rows are already-escalated history). Blank lines are ignored for both
 * the count and the output. Returns null when no trim is needed (<= maxLines
 * non-empty lines), so the caller can skip rewrite churn; otherwise the trimmed
 * content with a trailing newline. Pure: takes the raw file text.
 */
export function capJsonlTrail(raw: string, maxLines: number): string | null {
  const lines = raw.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length <= maxLines) return null
  return lines.slice(lines.length - maxLines).join('\n') + '\n'
}

export interface AbandonmentRate {
  /** Abandonments whose ts falls within [nowMs - windowMs, nowMs]. */
  count: number
  /** The trailing window width (ms) the count was taken over. */
  windowMs: number
  /** Abandonments grouped by recipient, to surface a single wedged target. */
  byRecipient: Record<string, number>
}

/**
 * Abandon-rate over a trailing window, from parsed sentinel events. This is the
 * observability the default-flip (fail-safe state machine, separate card) needs
 * as its safety net: flipping the pane-state default toward not-ready trades
 * false-READY for false-BUSY, which surfaces as a RISE in abandonments. A
 * baseline measured here lets that change be validated rather than guessed.
 *
 * Events with an unparseable timestamp, or one dated in the future relative to
 * `nowMs` (clock skew / NTP correction), are excluded so a bad timestamp cannot
 * inflate the rate. Pure: the clock is injected.
 */
export function abandonmentRate(
  events: AbandonmentEvent[],
  windowMs: number,
  nowMs: number,
): AbandonmentRate {
  const since = nowMs - windowMs
  const byRecipient: Record<string, number> = {}
  let count = 0
  for (const e of events) {
    const t = Date.parse(e.ts)
    if (!Number.isFinite(t) || t < since || t > nowMs) continue
    count++
    byRecipient[e.to] = (byRecipient[e.to] ?? 0) + 1
  }
  return { count, windowMs, byRecipient }
}
