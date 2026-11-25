// Immediate operator alert: a scheduled task was SKIPPED on this very tick
// because its agent's tmux session is gone (wedged / stopped agent -> the
// scheduler's 'missing' verdict). Card c7f289d8.
//
// Why this layer exists on top of the two backstops:
//
// The pending-retry escalation (pending-retry-alert.ts) and the stuck-next_run
// sentinel (stuck-task-sentinel.ts) both DO eventually tell the operator a
// missing-session task is not firing -- but the first waits 1h and the second
// 3h. For a process whose whole value is "it ran at 09:00", an hour of silence
// is an hour of a lost fire nobody knew about. Boss directive: processes must
// not stop silently.
//
// This alert fires on the SAME tick the fire is skipped, closing only that
// latency gap. It does not replace the backstops -- they stay unchanged and
// keep re-escalating chronic wedges on their own (escalating) cadence.
//
// Debounce: a single missed tick is not escalated, because a tmux restart
// momentarily removes a session from `list-sessions` and would otherwise spam
// one alert per restart. The scheduler already counts consecutive misses in the
// pending_task_retries row (attempt_count, reason 'missing'); this layer keys
// off that count and only fires once it reaches IMMEDIATE_MISS_ALERT_THRESHOLD.
//
// Dedup + recovery: one row per missing EPISODE in missed_fire_alerts, deleted
// the moment the task fires again -- so a task that wedges a second time alerts
// a second time. alert_sent_at is the per-episode cap, claimed before the send
// (so a slow network call cannot let the next tick duplicate) and released on a
// TRANSIENT send failure (retry next tick) but kept on a PERMANENT one (so a bad
// token does not spin every 60s). This is the exact pattern the stuck sentinel
// uses; it is reused rather than re-invented.
import { logger } from '../logger.js'
import { classifyTelegramSendError } from '../pending-retries.js'
import { defaultDeliver, type AlertDeliver } from './operator-alert.js'

/**
 * Consecutive missed ticks required before the immediate alert fires.
 *
 * Default 2: tick 1 is absorbed (a transient tmux restart that resolves by the
 * next 60s tick never alerts), tick 2 escalates. Named so the debounce boundary
 * is a single obvious knob rather than a magic number inlined at the call site.
 */
export const IMMEDIATE_MISS_ALERT_THRESHOLD = 2

type AlertDb = {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number }
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
  exec(sql: string): unknown
}

export interface MissedFireView {
  taskId: string
  agent: string
  /** Consecutive missed ticks so far (the pending-retry attempt_count). */
  missedCount: number
}

/**
 * Create the episode table if absent.
 *
 * Called on every use (not only at startup) for the same reason the stuck
 * sentinel does: the live noa.db is not rebuilt from schema-noa.sql, and the
 * sweep is reachable without startScheduleRunner. A missing table would throw
 * inside the tick.
 */
export function ensureMissedFireAlertTable(db: AlertDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS missed_fire_alerts (
      task_id       TEXT PRIMARY KEY,
      first_seen    INTEGER NOT NULL,
      alert_sent_at INTEGER
    )
  `)
}

/**
 * Claim the alert for this episode. Guarded on `alert_sent_at IS NULL`, so two
 * concurrent ticks cannot both win -- exactly one gets `changes > 0`.
 */
function claimAlert(db: AlertDb, taskId: string, nowS: number): boolean {
  return db.prepare(
    `UPDATE missed_fire_alerts SET alert_sent_at = ?
      WHERE task_id = ? AND alert_sent_at IS NULL`,
  ).run(nowS, taskId).changes > 0
}

function releaseAlert(db: AlertDb, taskId: string): void {
  db.prepare(`UPDATE missed_fire_alerts SET alert_sent_at = NULL WHERE task_id = ?`).run(taskId)
}

/**
 * Clear the episode stamp when a task recovers (fires again). Idempotent: a
 * no-op if the task never had a missing episode. Called from the sweep's
 * success path alongside deletePendingRetry.
 */
export function clearMissedFireAlert(db: AlertDb, taskId: string): void {
  db.prepare(`DELETE FROM missed_fire_alerts WHERE task_id = ?`).run(taskId)
}

export function formatMissedFireAlert(view: MissedFireView): string {
  return [
    `[Marveen scheduler] A(z) "${view.taskId}" (${view.agent}) utemezett feladat NEM tuzelt: az agens tmux session-je nem fut (akadt / leallt agens).`,
    `Ez ${view.missedCount} egymast koveto tick ota tart, tehat nem egy pillanatnyi ujrainditas. A fire AZONNAL elmaradt -- nem varunk az 1 oras / 3 oras backstopra.`,
    'Feloldas: dashboard /Utemezesek -> inditsd ujra az agens session-jet. A feladat magatol lefut, amint a session visszater (a scheduler ujraprobalkozik).',
  ].join('\n')
}

/**
 * Fire the immediate missed-fire alert for ONE task, at most once per episode.
 *
 * Preconditions the caller enforces: the task hit the 'missing' verdict this
 * tick AND its consecutive-miss count has reached IMMEDIATE_MISS_ALERT_THRESHOLD.
 *
 * Order and failure handling match the stuck-task sentinel: stamp before the
 * network call so a slow send cannot let the next tick duplicate, release the
 * stamp on a TRANSIENT failure so the next tick retries, keep it on a PERMANENT
 * one so a bad token does not spin every 60s.
 */
export function sendMissedFireAlert(
  view: MissedFireView,
  nowS: number,
  db: AlertDb,
  deliver: AlertDeliver = defaultDeliver,
): void {
  ensureMissedFireAlertTable(db)

  // INSERT OR IGNORE: first_seen belongs to the first observation of THIS
  // episode and must not drift forward on every tick.
  db.prepare('INSERT OR IGNORE INTO missed_fire_alerts (task_id, first_seen) VALUES (?, ?)')
    .run(view.taskId, nowS)

  if (!claimAlert(db, view.taskId, nowS)) return

  void deliver(formatMissedFireAlert(view)).then(
    () => {
      logger.info(
        { task: view.taskId, agent: view.agent, missedCount: view.missedCount },
        'scheduler: immediate missed-fire alert sent (wedged agent)',
      )
    },
    (err: unknown) => {
      const kind = classifyTelegramSendError(err instanceof Error ? err.message : String(err))
      if (kind === 'transient') {
        logger.warn({ err, task: view.taskId },
          'scheduler: immediate missed-fire alert failed (transient), clearing stamp for retry')
        releaseAlert(db, view.taskId)
      } else {
        logger.warn({ err, task: view.taskId },
          'scheduler: immediate missed-fire alert failed (permanent), stamp kept to avoid a 60s spin')
      }
    },
  )
}
