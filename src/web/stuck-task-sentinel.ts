// Backstop detector: an ACTIVE scheduled task whose `next_run` has been in the
// past far longer than any fire could legitimately take.
//
// Why this exists as a separate layer from the pending-retry escalation:
//
// `next_run` only ever advances via `rollForwardFired`, which only runs on a
// 'fired' verdict. Every other outcome leaves the field where it was. The retry
// escalation covers the outcomes that enqueue a row ('busy', 'parked'); it does
// NOT cover 'error', it does NOT cover 'missing' (session absent -> no retry row
// at all, which is how a re-enabled task for a stopped agent sits frozen), and
// by construction it cannot cover a failure mode nobody has thought of yet.
//
// On 2026-08-05 eleven tasks sat with `next_run` in the past for up to 78 hours.
// The retry escalation would have caught most of them -- except it had been
// dropped by a migration a fortnight earlier and had zero call sites. Nothing
// else was watching, so the only detector left was a human reading the table.
//
// This sentinel therefore watches the OUTCOME (`next_run` did not advance)
// rather than any particular cause, and deliberately does NOT skip tasks the
// retry queue already knows about: a backstop that goes quiet whenever the
// layer it backs up goes quiet is not a backstop. The two alerts say different
// things and are separately capped, so the duplication is bounded and useful.
import { logger } from '../logger.js'
import { classifyTelegramSendError } from '../pending-retries.js'
import { defaultDeliver, type AlertDeliver } from './operator-alert.js'

/**
 * How far into the past `next_run` may drift before this is an incident.
 *
 * Strictly ABOVE the retry escalation's 1h threshold so the sentinel is a
 * second opinion rather than a duplicate: for the failure modes both layers
 * can see, the retry alert always speaks first, and this one only follows if
 * the problem outlived it. Well above the 60s sweep interval, so a fire in
 * flight or a single skipped tick can never reach it.
 */
export const STUCK_THRESHOLD_S = 3 * 60 * 60

type SentinelDb = {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number }
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
  exec(sql: string): unknown
}

export interface StuckTaskView {
  taskId: string
  agent: string
  /** The scheduled slot the task never left, in seconds. */
  nextRun: number
  /** How far `next_run` is in the past, in seconds. */
  stuckForS: number
  /**
   * When THIS process first observed the task stuck. Distinct from `nextRun`
   * on purpose: if the dashboard was down for two days, the slot is ancient
   * but the observation is minutes old, and "the scheduler is broken" versus
   * "the scheduler was off" are different incidents.
   */
  firstSeen: number
  /** True if the retry queue is already tracking it -- see the header note. */
  hasPendingRetry: boolean
  lastResult: string | null
}

/**
 * Create the sentinel's own table if absent.
 *
 * Called on every sweep rather than only at startup: the live noa.db is not
 * rebuilt from scripts/schema-noa.sql, and `runSweepTick` is reachable without
 * `startScheduleRunner`. A missing table would throw inside the tick, and the
 * runner's catch-all would log it once a minute while the whole sweep -- not
 * just this sentinel -- stopped doing its job.
 */
export function ensureStuckTaskSentinelTable(db: SentinelDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stuck_task_alerts (
      task_id       TEXT PRIMARY KEY,
      first_seen    INTEGER NOT NULL,
      alert_sent_at INTEGER
    )
  `)
}

type StuckRow = {
  id: string
  agent: string
  next_run: number
  last_result: string | null
  pending_count: number
}

/** Read-only: active tasks whose next_run is stale past the threshold, oldest first. */
export function findStuckTasks(
  db: SentinelDb,
  nowS: number,
  thresholdS: number = STUCK_THRESHOLD_S,
): StuckTaskView[] {
  // Strict `<` (i.e. stale by MORE than the threshold). An exactly-N-wide
  // window compared with `<=` is how a boundary tick silently swallowed a
  // send on 08-04; the same shape is not repeated here.
  const rows = db.prepare(`
    SELECT t.id, t.agent, t.next_run, t.last_result,
           (SELECT COUNT(*) FROM pending_task_retries p WHERE p.task_name = t.id) AS pending_count
      FROM scheduled_tasks t
     WHERE t.status = 'active' AND t.next_run < ?
     ORDER BY t.next_run ASC
  `).all(nowS - thresholdS) as StuckRow[]

  return rows.map((r) => ({
    taskId: r.id,
    agent: r.agent,
    nextRun: r.next_run,
    stuckForS: nowS - r.next_run,
    firstSeen: nowS,
    hasPendingRetry: r.pending_count > 0,
    lastResult: r.last_result,
  }))
}

/**
 * Claim the alert for this episode. Guarded on `alert_sent_at IS NULL`, so two
 * concurrent ticks cannot both win -- exactly one gets `changes > 0`.
 */
function claimAlert(db: SentinelDb, taskId: string, nowS: number): boolean {
  return db.prepare(
    `UPDATE stuck_task_alerts SET alert_sent_at = ?
      WHERE task_id = ? AND alert_sent_at IS NULL`,
  ).run(nowS, taskId).changes > 0
}

function releaseAlert(db: SentinelDb, taskId: string): void {
  db.prepare(`UPDATE stuck_task_alerts SET alert_sent_at = NULL WHERE task_id = ?`).run(taskId)
}

function hoursAndMinutes(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0 ? `${h} ora ${m} perc` : `${m} perc`
}

export function formatStuckTaskAlert(view: StuckTaskView): string {
  const slot = new Date(view.nextRun * 1000).toLocaleString('hu-HU')
  const noticed = new Date(view.firstSeen * 1000).toLocaleString('hu-HU')
  // The two states are different faults and want different first moves, so
  // they get different sentences rather than a shared one with a flag in it.
  const context = view.hasPendingRetry
    ? 'A feladat BENNE VAN az ujraprobalkozasi sorban, tehat a scheduler probalkozik es valami visszatartja (jellemzoen foglalt vagy nem valaszolo agens-panel).'
    : 'A feladat NINCS BENNE az ujraprobalkozasi sorban: senki nem probalkozik vele. Ez jellemzoen hianyzo tmux session vagy ismetlodo fire-hiba.'
  return [
    `[Marveen scheduler] A(z) "${view.taskId}" (${view.agent}) utemezett feladat next_run mezoje ${hoursAndMinutes(view.stuckForS)} ota a multban all, tehat a feladat nem tuzel.`,
    `Elmaradt idopont: ${slot}. Eloszor eszlelve: ${noticed}. Utolso eredmeny: ${view.lastResult ?? 'ismeretlen'}.`,
    context,
    'Feloldas: dashboard /Utemezesek -> nezd meg az agens paneljet (fut-e a session, van-e bent nem elkuldott szoveg). A next_run magatol lep elore, amint a feladat egyszer sikeresen lefut.',
  ].join('\n')
}

/**
 * Escalate one stuck task, at most once per episode.
 *
 * Order and failure handling match the pending-retry escalation: stamp before
 * the network call so a slow send cannot let the next tick duplicate, release
 * the stamp on a TRANSIENT failure so the next tick retries, keep it on a
 * PERMANENT one so a bad token does not spin every 60s.
 */
export function sendStuckTaskAlert(
  view: StuckTaskView,
  nowS: number,
  db: SentinelDb,
  deliver: AlertDeliver = defaultDeliver,
): void {
  if (!claimAlert(db, view.taskId, nowS)) return

  void deliver(formatStuckTaskAlert(view)).then(
    () => {
      logger.info(
        { task: view.taskId, agent: view.agent, stuckForS: view.stuckForS },
        'scheduler: stuck-task sentinel alert sent',
      )
    },
    (err: unknown) => {
      const kind = classifyTelegramSendError(err instanceof Error ? err.message : String(err))
      if (kind === 'transient') {
        logger.warn({ err, task: view.taskId },
          'scheduler: stuck-task alert failed (transient), clearing stamp for retry')
        releaseAlert(db, view.taskId)
      } else {
        logger.warn({ err, task: view.taskId },
          'scheduler: stuck-task alert failed (permanent), stamp kept to avoid a 60s spin')
      }
    },
  )
}

/**
 * One sentinel pass: reconcile the episode table against reality, then
 * escalate whatever is newly stuck.
 *
 * The reconcile half is what keeps the cap from becoming a permanent mute. A
 * task that recovers loses its row, so if it wedges again next month it alerts
 * again -- the cap is scoped to an episode, not to the task's lifetime.
 */
export function sweepStuckTasks(
  nowS: number,
  db: SentinelDb,
  deliver: AlertDeliver = defaultDeliver,
  thresholdS: number = STUCK_THRESHOLD_S,
): void {
  ensureStuckTaskSentinelTable(db)

  const stuck = findStuckTasks(db, nowS, thresholdS)
  const stuckIds = new Set(stuck.map((v) => v.taskId))

  // Episode boundary: anything no longer stuck (recovered, paused, deleted)
  // drops its row. With nothing stuck this clears the table, which is correct.
  for (const row of db.prepare('SELECT task_id FROM stuck_task_alerts').all() as { task_id: string }[]) {
    if (!stuckIds.has(row.task_id)) {
      db.prepare('DELETE FROM stuck_task_alerts WHERE task_id = ?').run(row.task_id)
    }
  }

  for (const view of stuck) {
    // INSERT OR IGNORE: first_seen belongs to the first observation of THIS
    // episode and must not drift forward on every tick, or the "how long has
    // the scheduler been watching this" half of the message is worthless.
    db.prepare('INSERT OR IGNORE INTO stuck_task_alerts (task_id, first_seen) VALUES (?, ?)')
      .run(view.taskId, nowS)
    const seen = db.prepare('SELECT first_seen FROM stuck_task_alerts WHERE task_id = ?')
      .get(view.taskId) as { first_seen: number } | undefined

    sendStuckTaskAlert({ ...view, firstSeen: seen?.first_seen ?? nowS }, nowS, db, deliver)
  }
}
