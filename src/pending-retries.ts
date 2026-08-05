// Pure-logic helpers for the persistent scheduled-task retry queue.
//
// The scheduler used to keep busy-skipped tasks in an in-memory Map and
// abandon them after 15-60 minutes, silently. That failure mode is fatal
// for business-critical schedules (a morning summary that never arrives
// is only noticed hours later). The replacement policy is:
//
//   1. Every busy retry is upserted into `pending_task_retries` (persists
//      across dashboard restarts, so nothing is dropped).
//   2. On every tick, the scheduler tries to fire every pending row. On
//      success, the row is deleted; on continued busy, attempt_count ++.
//   3. If a row has been waiting longer than `ALERT_THRESHOLD_MS` and
//      `alert_sent_at` is null, the alerting layer stamps the row BEFORE
//      sending the Telegram message (so concurrent ticks do not
//      double-alert) and clears the stamp if the send fails (so the next
//      tick can retry). Net guarantee: one stamp per delivery attempt,
//      at-least-once delivery until success. The scheduled task itself
//      keeps retrying forever -- we do NOT abandon.
//
// This module contains the decision logic only; the I/O (DB + Telegram)
// lives in src/web.ts alongside the rest of the scheduler, but is wrapped
// behind small pure functions here so the "should we alert" decision can
// be unit-tested without a DB and without an HTTP mock.

/**
 * How long a busy-skipped scheduled task can wait before we escalate the
 * operator via Telegram. The retry itself continues forever: this is the
 * alerting threshold, not an abandon threshold.
 *
 * UNITS: seconds, matching what the sweep actually writes into
 * `pending_task_retries` (`Math.floor(Date.now() / 1000)`). This module used
 * to be milliseconds while the writer had already moved to seconds, so the
 * live `/api/schedules/pending` reported `ageDays=20649.6` (56 years) and
 * `alertDue=true` for every row -- a backstop that produced a number nobody
 * could act on. One unit, named in the identifier, at every boundary.
 */
export const ALERT_THRESHOLD_S = 60 * 60

/**
 * Coerce a stored timestamp to seconds.
 *
 * Rows written before the sweep migration hold MILLISECONDS. Left alone, such
 * a row makes `now - firstAttempt` hugely negative, which reads as "not old
 * enough yet" and silently never alerts -- the exact failure this module
 * exists to prevent. The cutoff (1e11 s ~= year 5138) cannot be a real
 * second-valued timestamp, so the discrimination is unambiguous.
 */
export function toSeconds(ts: number): number {
  if (!Number.isFinite(ts)) return ts
  return ts > 1e11 ? Math.floor(ts / 1000) : ts
}

/**
 * Decide whether the alerting layer should fire a Telegram notification
 * for a pending retry row.
 *
 * Returns true only when:
 *   - the row has been waiting longer than `thresholdS`, AND
 *   - no alert is currently stamped (`alertSentAt` is null).
 *
 * Callers are responsible for stamping `alert_sent_at` before the Telegram
 * send (race guard against concurrent ticks) and clearing it on delivery
 * failure so the next tick can retry.
 *
 * All timestamps are SECONDS (see ALERT_THRESHOLD_S).
 */
export function shouldSendAlert(
  nowS: number,
  firstAttemptS: number,
  alertSentAt: number | null,
  thresholdS: number = ALERT_THRESHOLD_S,
): boolean {
  if (alertSentAt != null) return false
  const first = toSeconds(firstAttemptS)
  if (!Number.isFinite(first) || first <= 0) return false
  if (!Number.isFinite(nowS) || nowS < first) return false
  return nowS - first > thresholdS
}

/**
 * Classify a Telegram send failure as transient (worth retrying) or
 * permanent (a config / client error that will fail identically every
 * tick). sendTelegramMessage throws `Error("Telegram API <status>: ...")`
 * on a non-2xx response and a bare network error (TypeError "fetch
 * failed") when the request never reaches Telegram.
 *
 *   - transient: network failure (no status), HTTP 429 (rate limited),
 *     or any 5xx. The next 60s tick should retry, so the caller clears
 *     the per-attempt stamp.
 *   - permanent: HTTP 4xx other than 429 (400 bad chat_id, 401/404 bad
 *     token, 403 blocked). Retrying every tick just spams the log with
 *     the identical failure, so the caller KEEPS the stamp to stop the
 *     alert from re-firing until the underlying config is fixed.
 *
 * Pure (takes the error message string) so it is unit-testable without a
 * live Telegram endpoint.
 */
export function classifyTelegramSendError(errMessage: string): 'transient' | 'permanent' {
  const m = /Telegram API (\d{3})\b/.exec(errMessage)
  if (!m) return 'transient' // no HTTP status -> network-level failure
  const status = Number(m[1])
  if (status === 429 || status >= 500) return 'transient'
  if (status >= 400) return 'permanent'
  return 'transient'
}

/**
 * Shape of a pending retry used by the UI + the alert layer. A small
 * subset of the DB row, decoupled from the DB type so tests don't need
 * better-sqlite3.
 */
export interface PendingRetryView {
  id: number
  taskName: string
  agentName: string
  firstAttempt: number
  lastAttempt: number
  attemptCount: number
  lastReason: string | null
  alertSentAt: number | null
  ageMs: number
  alertDue: boolean
}

/**
 * Project a raw DB row into the UI view, including the derived `ageMs`
 * (for display) and `alertDue` (= shouldSendAlert). Keeping the derivation
 * here means the UI never has to carry the alert policy.
 *
 * `nowS` and the row timestamps are SECONDS; `ageMs` stays milliseconds
 * because that is the established response contract the dashboard renders
 * (web/app.js formatPendingAge). The unit conversion happens here, once,
 * instead of being assumed differently on each side.
 */
export function toPendingRetryView(
  row: {
    id: number
    task_name: string
    agent_name: string
    first_attempt: number
    last_attempt: number
    attempt_count: number
    last_reason: string | null
    alert_sent_at: number | null
  },
  nowS: number,
  thresholdS: number = ALERT_THRESHOLD_S,
): PendingRetryView {
  return {
    id: row.id,
    taskName: row.task_name,
    agentName: row.agent_name,
    firstAttempt: row.first_attempt,
    lastAttempt: row.last_attempt,
    attemptCount: row.attempt_count,
    lastReason: row.last_reason,
    alertSentAt: row.alert_sent_at,
    ageMs: Math.max(0, nowS - toSeconds(row.first_attempt)) * 1000,
    alertDue: shouldSendAlert(nowS, row.first_attempt, row.alert_sent_at, thresholdS),
  }
}
