import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { sendPendingRetryAlert, formatPendingRetryAlert } from '../web/pending-retry-alert.js'
import { toPendingRetryView } from '../pending-retries.js'

// A real (in-memory) DB: the once-per-row cap IS the `alert_sent_at IS NULL`
// guard on the UPDATE, so asserting it against a mock would assert nothing.
function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
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
    )`)
  return db
}

const NOW_S = 1_800_000_000
const FIRST_S = NOW_S - 3 * 60 * 60 // stuck 3 hours

function seed(db: Database.Database): ReturnType<typeof toPendingRetryView> {
  db.prepare(`
    INSERT INTO pending_task_retries (task_name, agent_name, first_attempt, last_attempt, attempt_count, last_reason)
    VALUES ('morning-brief', 'claudia', ?, ?, 42, 'busy')
  `).run(FIRST_S, NOW_S)
  const row = db.prepare(`SELECT * FROM pending_task_retries WHERE task_name='morning-brief'`).get() as never
  return toPendingRetryView(row, NOW_S)
}

function stamp(db: Database.Database): number | null {
  const r = db.prepare(`SELECT alert_sent_at FROM pending_task_retries WHERE task_name='morning-brief'`)
    .get() as { alert_sent_at: number | null }
  return r.alert_sent_at
}

describe('sendPendingRetryAlert', () => {
  let db: Database.Database
  beforeEach(() => { db = freshDb() })

  it('stamps the row BEFORE delivering, so a slow send cannot let the next tick duplicate', () => {
    let stampAtDeliveryTime: number | null = 'unset' as never
    const deliver = vi.fn(() => {
      stampAtDeliveryTime = stamp(db)
      return Promise.resolve()
    })

    sendPendingRetryAlert(seed(db), NOW_S, db, deliver)

    expect(deliver).toHaveBeenCalledOnce()
    expect(stampAtDeliveryTime).toBe(NOW_S)
  })

  it('delivers at most once per row -- a wedged agent gets one message, not one per tick', () => {
    const deliver = vi.fn(() => Promise.resolve())
    const view = seed(db)

    sendPendingRetryAlert(view, NOW_S, db, deliver)
    sendPendingRetryAlert(view, NOW_S + 60, db, deliver)
    sendPendingRetryAlert(view, NOW_S + 120, db, deliver)

    expect(deliver).toHaveBeenCalledOnce()
  })

  it('releases the stamp on a TRANSIENT failure so the next tick can retry', async () => {
    const deliver = vi.fn(() => Promise.reject(new Error('fetch failed')))

    sendPendingRetryAlert(seed(db), NOW_S, db, deliver)
    await vi.waitFor(() => expect(stamp(db)).toBeNull())
  })

  it('KEEPS the stamp on a PERMANENT failure so a bad config does not spin every 60s', async () => {
    const deliver = vi.fn(() => Promise.reject(new Error('Telegram API 400: chat not found')))

    sendPendingRetryAlert(seed(db), NOW_S, db, deliver)
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce())
    expect(stamp(db)).toBe(NOW_S)
  })

  it('names the task, the agent, the age and the reason -- an alert nobody can act on is not an alert', () => {
    const text = formatPendingRetryAlert(seed(db))

    expect(text).toContain('morning-brief')
    expect(text).toContain('claudia')
    expect(text).toContain('180 perce') // 3 hours, from second-valued timestamps
    expect(text).toContain('busy')
    expect(text).toContain('42')
    // The 1970 smell of a seconds value fed to `new Date(ms)`.
    expect(text).not.toContain('1970')
  })
})
