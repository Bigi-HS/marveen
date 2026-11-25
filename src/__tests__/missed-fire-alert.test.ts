import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { initNoaDb, getNoaDb } from '../noa-memory.js'
import {
  IMMEDIATE_MISS_ALERT_THRESHOLD,
  ensureMissedFireAlertTable,
  clearMissedFireAlert,
  formatMissedFireAlert,
  sendMissedFireAlert,
  type MissedFireView,
} from '../web/missed-fire-alert.js'

// logger is noisy on the failure paths; silence it but keep it assertable.
vi.mock('../logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logger.js')>()
  return { ...actual, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }
})

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(__dirname, '..', '..', 'scripts', 'schema-noa.sql'), 'utf8')

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  // A writable PROJECT_ROOT in case defaultDeliver's config read is ever reached.
  mkdirSync(join(tmpdir(), 'noa-missed-fire-test'), { recursive: true })
  initNoaDb(':memory:')
  getNoaDb().exec(SCHEMA_SQL)
})

beforeEach(() => {
  getNoaDb().prepare('DELETE FROM missed_fire_alerts').run()
})
afterEach(() => {
  getNoaDb().prepare('DELETE FROM missed_fire_alerts').run()
})

const VIEW: MissedFireView = { taskId: 'wedged-task', agent: 'ghost', missedCount: 2 }

// Await any pending deliver().then() microtasks before asserting side-effects.
const flush = () => new Promise((r) => setImmediate(r))

describe('missed-fire-alert: debounce constant', () => {
  it('default threshold is 2 (one transient restart absorbed, second tick alerts)', () => {
    expect(IMMEDIATE_MISS_ALERT_THRESHOLD).toBe(2)
  })
})

describe('missed-fire-alert: message', () => {
  it('names the task, agent, the dead-session cause, and the consecutive-miss count', () => {
    const msg = formatMissedFireAlert(VIEW)
    expect(msg).toContain('wedged-task')
    expect(msg).toContain('ghost')
    expect(msg).toContain('tmux')
    expect(msg).toContain('2')
  })
})

describe('missed-fire-alert: dedup within an episode', () => {
  it('delivers exactly once across repeated sends while still missing', async () => {
    const db = getNoaDb()
    const deliver = vi.fn().mockResolvedValue(undefined)
    const nowS = 1_000_000

    sendMissedFireAlert(VIEW, nowS, db, deliver)
    await flush()
    sendMissedFireAlert({ ...VIEW, missedCount: 3 }, nowS + 60, db, deliver)
    await flush()
    sendMissedFireAlert({ ...VIEW, missedCount: 4 }, nowS + 120, db, deliver)
    await flush()

    expect(deliver).toHaveBeenCalledTimes(1)
    const row = db.prepare('SELECT * FROM missed_fire_alerts WHERE task_id = ?')
      .get('wedged-task') as { alert_sent_at: number | null }
    expect(row.alert_sent_at).toBe(nowS)
  })
})

describe('missed-fire-alert: recovery clears the episode', () => {
  it('clearMissedFireAlert removes the row so a later episode alerts again', async () => {
    const db = getNoaDb()
    const deliver = vi.fn().mockResolvedValue(undefined)

    sendMissedFireAlert(VIEW, 1000, db, deliver)
    await flush()
    expect(deliver).toHaveBeenCalledTimes(1)

    // Task recovers.
    clearMissedFireAlert(db, 'wedged-task')
    expect(db.prepare('SELECT * FROM missed_fire_alerts WHERE task_id = ?').get('wedged-task'))
      .toBeUndefined()

    // New episode later -> alerts again.
    sendMissedFireAlert({ ...VIEW, missedCount: 2 }, 5000, db, deliver)
    await flush()
    expect(deliver).toHaveBeenCalledTimes(2)
  })

  it('clearMissedFireAlert is a no-op when there was never an episode', () => {
    const db = getNoaDb()
    ensureMissedFireAlertTable(db)
    expect(() => clearMissedFireAlert(db, 'never-wedged')).not.toThrow()
  })
})

describe('missed-fire-alert: send-failure handling', () => {
  it('TRANSIENT failure releases the stamp so the next tick retries', async () => {
    const db = getNoaDb()
    // Network-level error -> classifyTelegramSendError returns 'transient'.
    const deliver = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(undefined)

    sendMissedFireAlert(VIEW, 1000, db, deliver)
    await flush()

    // Stamp cleared -> row present but alert_sent_at NULL.
    const row = db.prepare('SELECT * FROM missed_fire_alerts WHERE task_id = ?')
      .get('wedged-task') as { alert_sent_at: number | null }
    expect(row.alert_sent_at).toBeNull()

    // Next tick re-sends because the claim is available again.
    sendMissedFireAlert({ ...VIEW, missedCount: 3 }, 1060, db, deliver)
    await flush()
    expect(deliver).toHaveBeenCalledTimes(2)
  })

  it('PERMANENT failure keeps the stamp so it does not spin every tick', async () => {
    const db = getNoaDb()
    // HTTP 401 -> 'permanent'.
    const deliver = vi.fn().mockRejectedValue(new Error('Telegram API 401: bad token'))

    sendMissedFireAlert(VIEW, 1000, db, deliver)
    await flush()

    const row = db.prepare('SELECT * FROM missed_fire_alerts WHERE task_id = ?')
      .get('wedged-task') as { alert_sent_at: number | null }
    expect(row.alert_sent_at).toBe(1000) // kept

    // A later send does not re-deliver (claim held).
    sendMissedFireAlert({ ...VIEW, missedCount: 3 }, 1060, db, deliver)
    await flush()
    expect(deliver).toHaveBeenCalledTimes(1)
  })
})
