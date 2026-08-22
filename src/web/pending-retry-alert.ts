// Operator escalation for scheduled tasks stuck in the retry queue.
//
// This layer existed in the file-based schedule runner and was lost in the A4
// migration (commit 8e65ac2) when the sweep moved to src/noa-scheduler.ts: the
// new sweep re-implemented the happy path only, so `sendPendingRetryAlert` was
// left with zero call sites while still reading like live code. The cost of
// that silence was measured on 2026-08-05 -- eleven scheduled tasks stuck for
// up to 78 hours, 4802 retries on the worst row, and `alert_sent_at` NULL on
// every single one. Nobody was told, because nothing could tell anybody.
//
// The module is separate (rather than living in the sweep) so both the sweep
// and any future caller can reach it without importing the legacy runner, and
// so the delivery seam is injectable for tests -- a test must never be able to
// send a real Telegram message.
import { logger } from '../logger.js'
import { classifyTelegramSendError, reAlertIntervalS, type PendingRetryView } from '../pending-retries.js'
import { defaultDeliver, type AlertDeliver } from './operator-alert.js'

export type { AlertDeliver }

type AlertDb = {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number }
  }
}

/**
 * Claim the alert for this row. The UPDATE is guarded on `alert_sent_at IS
 * NULL`, so two concurrent ticks (or a tick racing a crash-restart) cannot
 * both win -- exactly one gets `changes > 0` and therefore exactly one send is
 * attempted per stamp.
 */
function claimAlert(
  db: AlertDb,
  taskName: string,
  agentName: string,
  nowS: number,
  reAlertAfterS: number,
): boolean {
  // Claim the alert slot when either:
  //   - never alerted (alert_sent_at IS NULL), OR
  //   - the re-alert interval since the last notification has elapsed.
  // The UPDATE guard is atomic: concurrent ticks racing on the same row
  // cannot both win, so exactly one send is attempted per stamp.
  return db.prepare(
    `UPDATE pending_task_retries SET alert_sent_at = ?
      WHERE task_name = ? AND agent_name = ?
        AND (alert_sent_at IS NULL OR ? - alert_sent_at > ?)`
  ).run(nowS, taskName, agentName, nowS, reAlertAfterS).changes > 0
}

function releaseAlert(db: AlertDb, taskName: string, agentName: string): void {
  db.prepare(
    `UPDATE pending_task_retries SET alert_sent_at = NULL
      WHERE task_name = ? AND agent_name = ?`
  ).run(taskName, agentName)
}

export function formatPendingRetryAlert(view: PendingRetryView): string {
  const ageMinutes = Math.floor(view.ageMs / 60000)
  const firstAttempt = new Date(view.firstAttempt * 1000).toLocaleString('hu-HU')
  return [
    `[Marveen scheduler] A(z) "${view.taskName}" (${view.agentName}) utemezett feladat ${ageMinutes} perce varakozik.`,
    `Elso probalkozas: ${firstAttempt}. Ok: ${view.lastReason ?? 'ismeretlen'}, ${view.attemptCount} probalkozas.`,
    'A rendszer tovabb probalkozik; a dashboard /Utemezesek oldalan visszavonhato.',
  ].join('\n')
}

/**
 * Escalate one stuck retry row to the operator, at most once per stamp.
 *
 * Order matters: the row is stamped BEFORE the network call, so a slow or
 * hung send cannot let the next 60s tick fire a duplicate. On a TRANSIENT
 * failure (network, 429, 5xx) the stamp is released so the next tick retries;
 * on a PERMANENT one (4xx: bad token or chat id) the stamp is KEPT and acts as
 * the throttle -- retrying every minute would repeat the identical rejection
 * forever. The scheduled task itself keeps retrying either way: this is an
 * alerting threshold, never an abandon threshold.
 *
 * `nowS` is SECONDS, matching what the sweep writes.
 */
export function sendPendingRetryAlert(
  view: PendingRetryView,
  nowS: number,
  db: AlertDb,
  deliver: AlertDeliver = defaultDeliver,
): void {
  const intervalS = reAlertIntervalS(view.ageMs / 1000)
  if (!claimAlert(db, view.taskName, view.agentName, nowS, intervalS)) return

  void deliver(formatPendingRetryAlert(view)).then(
    () => {
      logger.info(
        { task: view.taskName, agent: view.agentName, ageMinutes: Math.floor(view.ageMs / 60000) },
        'scheduler: pending-retry alert sent',
      )
    },
    (err: unknown) => {
      const kind = classifyTelegramSendError(err instanceof Error ? err.message : String(err))
      if (kind === 'transient') {
        logger.warn({ err, task: view.taskName, agent: view.agentName },
          'scheduler: pending-retry alert failed (transient), clearing stamp for retry')
        releaseAlert(db, view.taskName, view.agentName)
      } else {
        logger.warn({ err, task: view.taskName, agent: view.agentName },
          'scheduler: pending-retry alert failed (permanent), stamp kept to avoid a 60s spin')
      }
    },
  )
}
