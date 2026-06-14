// Pure decision logic for the delivery-abandonment sentinel CONSUMER (card
// d37df625). PR #130 shipped the WRITE side: every abandoned/overdue inter-agent
// message is appended as one JSONL line to store/.delivery-abandonment-alerts
// .jsonl, a durable trail for the case where the in-band alert is ITSELF lost
// (the recipient is the wedged main agent, or the API is down). This module
// decides which of those lines warrant an out-of-band escalation, turning a
// silent drop into a minutes-latency Telegram fallback ping.
//
// CARD 7557a98d changed the cursor from a scalar high-water id to a PER-ID last
// -escalated timestamp. The router now re-appends a row for the same message id
// on a throttled cadence while it stays pending (the periodic re-alert), so a
// single overdue delivery is nagged hourly instead of pinged once and forgotten.
// A scalar id-cursor would dedupe every repeat of an already-seen id and defeat
// that; keying on (id -> latest-escalated ts) lets a FRESH round (a newer ts for
// the same id) re-fire while still deduping a row already sent.
//
// Dependency-free (only a type import) so it is unit-testable without the fs /
// Telegram IO, which lives in the thin CLI (src/delivery-sentinel-cli.ts).

import type { AbandonmentEvent } from './delivery-alert.js'
import { shouldAlertOnAbandon } from './delivery-alert.js'

// id (as a string key) -> epoch-ms of the latest sentinel row already escalated
// (or baselined past) for that id. An empty map means "never run" -- used to
// baseline the first run instead of flooding the operator with history.
export interface SentinelCursor {
  lastEscalatedTs: Record<string, number>
}

export const EMPTY_SENTINEL_CURSOR: SentinelCursor = { lastEscalatedTs: {} }

export interface SentinelEscalationPlan {
  /** Events to escalate out-of-band on this run, ascending by id (the latest
   * row per fresh id -- not every accumulated round, to bound spam). */
  escalations: AbandonmentEvent[]
  /** Cursor to persist AFTER a successful escalation (or after a baseline). */
  nextCursor: SentinelCursor
  /** True when this run only baselined the cursor past existing history
   * without escalating (first run on a non-empty sentinel). */
  baselined: boolean
}

export interface SelectEscalationOpts {
  /** Max ids escalated in a single run, to bound out-of-band spam when a wedged
   * target abandons a burst. The remainder escalate on later runs. Default 25. */
  maxPerRun?: number
  /** When true (default) and the cursor is empty on a non-empty sentinel, the
   * run BASELINES: it records the high-water ts per id without sending, so a
   * deploy does not replay historical drops. Set false to escalate the backlog
   * too (operator opt-in). */
  baselineOnFirstRun?: boolean
}

const DEFAULT_MAX_PER_RUN = 25

function isEmptyCursor(cursor: SentinelCursor): boolean {
  return Object.keys(cursor.lastEscalatedTs).length === 0
}

/**
 * Migrate / sanitize a persisted cursor value of unknown shape into a valid
 * SentinelCursor. A pre-7557a98d cursor is the scalar `{ lastEscalatedId }`;
 * since we cannot reconstruct per-id timestamps from it, we drop to an empty
 * cursor and let the next run BASELINE (record the current high-water ts per id,
 * escalate nothing) -- safe, no replay of history. Any malformed value does the
 * same.
 */
export function normalizeCursor(parsed: unknown): SentinelCursor {
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    const raw = obj.lastEscalatedTs
    if (raw && typeof raw === 'object') {
      const out: Record<string, number> = {}
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
      }
      return { lastEscalatedTs: out }
    }
  }
  // Old scalar cursor or garbage -> baseline fresh next run.
  return { lastEscalatedTs: {} }
}

// Collapse a stream of rows to the single latest-ts row per id, discarding rows
// with a non-finite id or an unparseable timestamp. Returns a map id -> { event,
// tsMs } so callers can compare against the per-id cursor.
function latestPerId(events: AbandonmentEvent[]): Map<number, { event: AbandonmentEvent; tsMs: number }> {
  const latest = new Map<number, { event: AbandonmentEvent; tsMs: number }>()
  for (const e of events) {
    if (!Number.isFinite(e.id)) continue
    const tsMs = Date.parse(e.ts)
    if (!Number.isFinite(tsMs)) continue
    const prev = latest.get(e.id)
    if (!prev || tsMs > prev.tsMs) latest.set(e.id, { event: e, tsMs })
  }
  return latest
}

/**
 * Decide which sentinel events to escalate, given the parsed events and the
 * persisted per-id cursor. Pure: no IO, no clock.
 *
 *   - First run (empty cursor) on a NON-EMPTY sentinel and baselineOnFirstRun:
 *     baseline only -- record the latest ts per id, escalate nothing.
 *   - Otherwise: an id is FRESH when its latest-row ts is newer than the ts we
 *     last escalated for it (or it was never escalated). Escalate the latest row
 *     of each fresh id, ascending by id, capped at maxPerRun; the cursor advances
 *     only THROUGH what is escalated, so a capped remainder is picked up next run
 *     and a failed send (caller does not persist the cursor) is retried.
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

  // Recursion guard (card 6774b3db): the out-of-band path must not escalate the
  // delivery-monitor's OWN abandoned alerts. When the main agent is busy for the
  // whole window, the monitor's hourly "X is overdue" alerts pile up undelivered
  // and would otherwise flood the operator with backstop-about-backstop pings
  // (47% of the 2026-06-14 overnight flood). The same recognition the in-band
  // path uses (shouldAlertOnAbandon) excludes them here. The JSONL row is still
  // written upstream for forensics; the underlying real message is traced and
  // escalated on its own row, so dropping the monitor row only removes the
  // double-count -- never a genuine signal.
  const latest = latestPerId(events.filter((e) => shouldAlertOnAbandon(e.from)))

  // First run on a non-empty sentinel: baseline past history.
  if (baselineOnFirstRun && isEmptyCursor(cursor) && latest.size > 0) {
    const baseline: Record<string, number> = {}
    for (const [id, { tsMs }] of latest) baseline[id] = tsMs
    return { escalations: [], nextCursor: { lastEscalatedTs: baseline }, baselined: true }
  }

  const fresh = [...latest.entries()]
    .filter(([id, { tsMs }]) => tsMs > (cursor.lastEscalatedTs[id] ?? -Infinity))
    .sort((a, b) => a[0] - b[0])
    .slice(0, maxPerRun)

  const nextTs = { ...cursor.lastEscalatedTs }
  for (const [id, { tsMs }] of fresh) nextTs[id] = tsMs

  return {
    escalations: fresh.map(([, { event }]) => event),
    nextCursor: { lastEscalatedTs: nextTs },
    baselined: false,
  }
}

/**
 * Build the out-of-band Telegram fallback body for a batch of abandoned/overdue
 * deliveries. One line per message (id, parties, age, phase) so the operator can
 * tell a still-retrying overdue delivery (no action) from a hard-dropped one
 * (re-send). Returns '' for an empty batch so the caller sends nothing.
 */
export function sentinelAlertText(escalations: AbandonmentEvent[]): string {
  if (escalations.length === 0) return ''
  const n = escalations.length
  const hasDropped = escalations.some((e) => e.phase !== 'overdue')
  const head =
    `⚠️ Delivery backstop: ${n} inter-agent delivery alert${n === 1 ? '' : 's'} ` +
    `(out-of-band -- the in-band alert may also have been lost).`
  const lines = escalations.map((e) => {
    const state = e.phase === 'overdue' ? 'still retrying' : 'GIVEN UP (hard limit)'
    return `- #${e.id} ${e.from} -> ${e.to} (${e.age_min}m, ${state})`
  })
  const tail = hasDropped
    ? 'Check the recipient session(s) and re-send what still matters.'
    : 'Recipient busy; delivery keeps retrying. No action needed unless it persists.'
  return [head, ...lines, tail].join('\n')
}
