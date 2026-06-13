// Pure decision logic for the delivery-abandonment sentinel CONSUMER (card
// d37df625). PR #130 shipped the WRITE side: every abandoned inter-agent
// message is appended as one JSONL line to store/.delivery-abandonment-alerts
// .jsonl, a durable trail for the case where the in-band alert is ITSELF lost
// (the abandoned message's recipient is the wedged main agent, or the API is
// down). This module decides which of those lines are NEW since the last run
// and warrant an out-of-band escalation, turning a silent 6-hour drop into a
// minutes-latency Telegram fallback ping.
//
// Dependency-free (only a type import) so it is unit-testable without the fs /
// Telegram IO, which lives in the thin CLI (src/delivery-sentinel-cli.ts).

import type { AbandonmentEvent } from './delivery-alert.js'

// The cursor persists the highest abandonment id already escalated (or
// baselined past). agent_messages ids are monotonic and start at 1, so a
// lastEscalatedId of 0 unambiguously means "never run" -- used to baseline the
// first run instead of flooding the operator with pre-existing history.
export interface SentinelCursor {
  lastEscalatedId: number
}

export const EMPTY_SENTINEL_CURSOR: SentinelCursor = { lastEscalatedId: 0 }

export interface SentinelEscalationPlan {
  /** Events to escalate out-of-band on this run, ascending by id. */
  escalations: AbandonmentEvent[]
  /** Cursor to persist AFTER a successful escalation (or after a baseline). */
  nextCursor: SentinelCursor
  /** True when this run only baselined the cursor past existing history
   * without escalating (first run on a non-empty sentinel). */
  baselined: boolean
}

export interface SelectEscalationOpts {
  /** Max events escalated in a single run, to bound out-of-band spam when a
   * wedged target abandons a burst. The remainder escalate on later runs.
   * Default 25. */
  maxPerRun?: number
  /** When true (default) and the cursor is at its initial state on a non-empty
   * sentinel, the run BASELINES: it advances the cursor past all existing
   * events without sending, so a deploy does not replay historical drops. Set
   * false to escalate the backlog too (operator opt-in). */
  baselineOnFirstRun?: boolean
}

const DEFAULT_MAX_PER_RUN = 25

function maxId(events: AbandonmentEvent[], floor: number): number {
  let m = floor
  for (const e of events) {
    if (Number.isFinite(e.id) && e.id > m) m = e.id
  }
  return m
}

/**
 * Decide which sentinel events to escalate, given the parsed events and the
 * persisted cursor. Pure: no IO, no clock.
 *
 *   - First run (cursor 0) on a NON-EMPTY sentinel and baselineOnFirstRun:
 *     baseline only -- advance the cursor past all history, escalate nothing.
 *   - Otherwise: escalate events with id > cursor, ascending, capped at
 *     maxPerRun; the cursor advances only THROUGH what is escalated so a
 *     capped remainder is picked up next run and a failed send (caller does
 *     not persist the cursor) is retried.
 *
 * Events with a non-finite id (a torn / malformed sentinel row that slipped
 * past parsing) are ignored so they can neither escalate nor corrupt the
 * cursor.
 */
export function selectSentinelEscalations(
  events: AbandonmentEvent[],
  cursor: SentinelCursor,
  opts: SelectEscalationOpts = {},
): SentinelEscalationPlan {
  const rawMax = opts.maxPerRun
  const maxPerRun = typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0
    ? Math.floor(rawMax)
    : DEFAULT_MAX_PER_RUN
  const baselineOnFirstRun = opts.baselineOnFirstRun ?? true

  const valid = events.filter((e) => Number.isFinite(e.id))

  // First run on a non-empty sentinel: baseline past history.
  if (baselineOnFirstRun && cursor.lastEscalatedId === 0 && valid.length > 0) {
    return {
      escalations: [],
      nextCursor: { lastEscalatedId: maxId(valid, 0) },
      baselined: true,
    }
  }

  const fresh = valid
    .filter((e) => e.id > cursor.lastEscalatedId)
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
 * Build the out-of-band Telegram fallback body for a batch of abandoned
 * deliveries. One line per drop (id, parties, age) so the operator can locate
 * and re-send. Returns '' for an empty batch so the caller sends nothing.
 */
export function sentinelAlertText(escalations: AbandonmentEvent[]): string {
  if (escalations.length === 0) return ''
  const n = escalations.length
  const head =
    `⚠️ Delivery backstop: ${n} inter-agent message${n === 1 ? '' : 's'} abandoned ` +
    `(out-of-band escalation -- the in-band alert may also have been lost).`
  const lines = escalations.map(
    (e) => `- #${e.id} ${e.from} -> ${e.to} (${e.age_min}m ago)`,
  )
  const tail = 'Check the recipient session(s) and re-send if it still matters.'
  return [head, ...lines, tail].join('\n')
}
