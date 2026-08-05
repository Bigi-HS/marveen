import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import {
  STUCK_THRESHOLD_S,
  ensureStuckTaskSentinelTable,
  findStuckTasks,
  formatStuckTaskAlert,
  sweepStuckTasks,
} from '../web/stuck-task-sentinel.js'

// A real (in-memory) DB throughout: the once-per-episode cap IS the
// `alert_sent_at IS NULL` guard on the UPDATE, and the "no longer stuck"
// reset IS a DELETE. Both are SQL, so asserting them against a mock would
// assert nothing. Same reasoning as pending-retry-alert.test.ts.
function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE scheduled_tasks (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'task',
      description TEXT,
      prompt TEXT,
      schedule TEXT NOT NULL,
      next_run INTEGER NOT NULL,
      last_run INTEGER,
      last_result TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE pending_task_retries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_name TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      first_attempt INTEGER NOT NULL,
      last_attempt INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      last_reason TEXT,
      alert_sent_at INTEGER,
      UNIQUE(task_name, agent_name)
    );
  `)
  ensureStuckTaskSentinelTable(db)
  return db
}

const NOW_S = 1_800_000_000

function addTask(
  db: Database.Database,
  id: string,
  nextRun: number,
  opts: { status?: string; agent?: string; lastResult?: string | null } = {},
): void {
  db.prepare(`
    INSERT INTO scheduled_tasks (id, agent, schedule, next_run, last_run, last_result, status, created_at)
    VALUES (?, ?, '0 * * * *', ?, NULL, ?, ?, 0)
  `).run(id, opts.agent ?? 'claudia', nextRun, opts.lastResult ?? null, opts.status ?? 'active')
}

function sentinelRow(db: Database.Database, taskId: string) {
  return db.prepare('SELECT * FROM stuck_task_alerts WHERE task_id = ?').get(taskId) as
    | { task_id: string; first_seen: number; alert_sent_at: number | null }
    | undefined
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe('findStuckTasks', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('ignores a task whose next_run is still in the future', () => {
    addTask(db, 'healthy', NOW_S + 600)
    expect(findStuckTasks(db, NOW_S)).toEqual([])
  })

  it('ignores a task only briefly overdue -- a fire in flight is not a stuck task', () => {
    addTask(db, 'just-due', NOW_S - 90)
    expect(findStuckTasks(db, NOW_S)).toEqual([])
  })

  it('does NOT fire exactly at the threshold (strict >), so a boundary tick cannot alert', () => {
    // A daily task plus an exactly-N-wide window is how the 08-04 cron dedup
    // race hid a missed send. Same boundary, same strict comparison.
    addTask(db, 'boundary', NOW_S - STUCK_THRESHOLD_S)
    expect(findStuckTasks(db, NOW_S)).toEqual([])

    addTask(db, 'past-boundary', NOW_S - STUCK_THRESHOLD_S - 1)
    expect(findStuckTasks(db, NOW_S).map((v) => v.taskId)).toEqual(['past-boundary'])
  })

  it('reports a task stuck past the threshold, with how long and by whom', () => {
    addTask(db, 'token-usage-collect', NOW_S - 78 * 3600, { agent: 'forge', lastResult: 'fired' })

    const [view] = findStuckTasks(db, NOW_S)

    expect(view).toMatchObject({
      taskId: 'token-usage-collect',
      agent: 'forge',
      nextRun: NOW_S - 78 * 3600,
      stuckForS: 78 * 3600,
      lastResult: 'fired',
      hasPendingRetry: false,
    })
  })

  it('ignores paused and deleted tasks -- their next_run is frozen on purpose', () => {
    addTask(db, 'paused-task', NOW_S - 10 * 3600, { status: 'paused' })
    addTask(db, 'deleted-task', NOW_S - 10 * 3600, { status: 'deleted' })
    expect(findStuckTasks(db, NOW_S)).toEqual([])
  })

  it('still reports a task that IS in the retry queue, flagged as such', () => {
    // The point of a backstop is that it does not share a failure mode with
    // the layer it backs up. If the sentinel skipped every row the retry
    // escalation "has", then a second regression in that escalation would
    // silence BOTH detectors at once -- which is exactly what happened when
    // the A4 migration dropped it and nothing else noticed for 78 hours.
    addTask(db, 'wedged', NOW_S - 10 * 3600, { agent: 'claudia' })
    db.prepare(`
      INSERT INTO pending_task_retries (task_name, agent_name, first_attempt, last_attempt, last_reason)
      VALUES ('wedged', 'claudia', ?, ?, 'busy')
    `).run(NOW_S - 10 * 3600, NOW_S)

    const [view] = findStuckTasks(db, NOW_S)
    expect(view.taskId).toBe('wedged')
    expect(view.hasPendingRetry).toBe(true)
  })

  it('orders the oldest stuck task first', () => {
    addTask(db, 'newer', NOW_S - 4 * 3600)
    addTask(db, 'oldest', NOW_S - 40 * 3600)
    expect(findStuckTasks(db, NOW_S).map((v) => v.taskId)).toEqual(['oldest', 'newer'])
  })
})

// ---------------------------------------------------------------------------
// Bookkeeping + escalation
// ---------------------------------------------------------------------------

describe('sweepStuckTasks', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('alerts once per episode -- a permanently stuck task does not alert every 60s', () => {
    addTask(db, 'wedged', NOW_S - 10 * 3600)
    const deliver = vi.fn(() => Promise.resolve())

    sweepStuckTasks(NOW_S, db, deliver)
    sweepStuckTasks(NOW_S + 60, db, deliver)
    sweepStuckTasks(NOW_S + 120, db, deliver)

    expect(deliver).toHaveBeenCalledOnce()
  })

  it('stamps first_seen on the first observation and never moves it', () => {
    addTask(db, 'wedged', NOW_S - 10 * 3600)
    const deliver = vi.fn(() => Promise.resolve())

    sweepStuckTasks(NOW_S, db, deliver)
    expect(sentinelRow(db, 'wedged')?.first_seen).toBe(NOW_S)

    sweepStuckTasks(NOW_S + 3600, db, deliver)
    expect(sentinelRow(db, 'wedged')?.first_seen).toBe(NOW_S)
  })

  it('clears the sentinel row once the task recovers, so a LATER episode alerts again', () => {
    addTask(db, 'wedged', NOW_S - 10 * 3600)
    const deliver = vi.fn(() => Promise.resolve())

    sweepStuckTasks(NOW_S, db, deliver)
    expect(deliver).toHaveBeenCalledOnce()

    // Recovered: next_run advanced into the future.
    db.prepare('UPDATE scheduled_tasks SET next_run = ? WHERE id = ?').run(NOW_S + 3600, 'wedged')
    sweepStuckTasks(NOW_S + 60, db, deliver)
    expect(sentinelRow(db, 'wedged')).toBeUndefined()

    // Stuck again, months later. A cap that never resets is a permanent mute.
    db.prepare('UPDATE scheduled_tasks SET next_run = ? WHERE id = ?').run(NOW_S - 10 * 3600, 'wedged')
    sweepStuckTasks(NOW_S + 120, db, deliver)
    expect(deliver).toHaveBeenCalledTimes(2)
  })

  it('stamps BEFORE delivering, so a slow send cannot let the next tick duplicate', () => {
    addTask(db, 'wedged', NOW_S - 10 * 3600)
    let stampAtDeliveryTime: number | null = 'unset' as never
    const deliver = vi.fn(() => {
      stampAtDeliveryTime = sentinelRow(db, 'wedged')?.alert_sent_at ?? null
      return Promise.resolve()
    })

    sweepStuckTasks(NOW_S, db, deliver)

    expect(stampAtDeliveryTime).toBe(NOW_S)
  })

  it('releases the stamp on a TRANSIENT failure so the next tick can retry', async () => {
    addTask(db, 'wedged', NOW_S - 10 * 3600)
    const deliver = vi.fn(() => Promise.reject(new Error('fetch failed')))

    sweepStuckTasks(NOW_S, db, deliver)
    await vi.waitFor(() => expect(sentinelRow(db, 'wedged')?.alert_sent_at).toBeNull())
  })

  it('KEEPS the stamp on a PERMANENT failure so a bad config does not spin every 60s', async () => {
    addTask(db, 'wedged', NOW_S - 10 * 3600)
    const deliver = vi.fn(() => Promise.reject(new Error('Telegram API 400: chat not found')))

    sweepStuckTasks(NOW_S, db, deliver)
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce())
    expect(sentinelRow(db, 'wedged')?.alert_sent_at).toBe(NOW_S)
  })

  it('alerts per task, not once for the whole batch', () => {
    addTask(db, 'a', NOW_S - 10 * 3600)
    addTask(db, 'b', NOW_S - 20 * 3600)
    const deliver = vi.fn(() => Promise.resolve())

    sweepStuckTasks(NOW_S, db, deliver)

    expect(deliver).toHaveBeenCalledTimes(2)
  })

  it('creates its own table, so a live DB predating this feature is not a crash', () => {
    const bare = new Database(':memory:')
    bare.exec(`
      CREATE TABLE scheduled_tasks (
        id TEXT PRIMARY KEY, agent TEXT NOT NULL, schedule TEXT NOT NULL,
        next_run INTEGER NOT NULL, last_run INTEGER, last_result TEXT,
        status TEXT NOT NULL DEFAULT 'active'
      );
      CREATE TABLE pending_task_retries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_name TEXT NOT NULL, agent_name TEXT NOT NULL,
        first_attempt INTEGER NOT NULL, last_attempt INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 1, last_reason TEXT, alert_sent_at INTEGER,
        UNIQUE(task_name, agent_name)
      );
    `)
    bare.prepare(`
      INSERT INTO scheduled_tasks (id, agent, schedule, next_run, status)
      VALUES ('wedged', 'claudia', '0 * * * *', ?, 'active')
    `).run(NOW_S - 10 * 3600)
    const deliver = vi.fn(() => Promise.resolve())

    expect(() => sweepStuckTasks(NOW_S, bare, deliver)).not.toThrow()
    expect(deliver).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

describe('formatStuckTaskAlert', () => {
  it('names the task, the agent, the staleness and the step that resolves it', () => {
    const text = formatStuckTaskAlert({
      taskId: 'token-usage-collect',
      agent: 'forge',
      nextRun: NOW_S - 78 * 3600,
      stuckForS: 78 * 3600,
      firstSeen: NOW_S - 3600,
      hasPendingRetry: false,
      lastResult: 'fired',
    })

    expect(text).toContain('token-usage-collect')
    expect(text).toContain('forge')
    expect(text).toContain('78') // hours stale
    // An alert that does not name the resolving step is a banner, not an alert.
    expect(text.toLowerCase()).toContain('utemezesek')
    // The 1970 smell of a seconds value fed to `new Date(ms)`.
    expect(text).not.toContain('1970')
  })

  it('distinguishes "nobody is even retrying" from "known-retrying" -- different faults', () => {
    const base = {
      taskId: 't', agent: 'a', nextRun: NOW_S - 10 * 3600,
      stuckForS: 10 * 3600, firstSeen: NOW_S, lastResult: null,
    }
    const orphan = formatStuckTaskAlert({ ...base, hasPendingRetry: false })
    const retrying = formatStuckTaskAlert({ ...base, hasPendingRetry: true })

    expect(orphan).not.toBe(retrying)
  })
})
