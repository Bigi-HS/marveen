import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDatabase, getDb } from '../db.js'
import { applyBBlockColumns } from '../noa-scheduler.js'

// Card b38c3231 -- de-brand BOOT-BLOCKER.
//
// A clean-room NoA deploy starts from a FRESH, empty noa.db. initDatabase()
// creates scheduled_tasks; the scheduler then INSERTs rows shaped
// (id, agent, type, description, prompt, schedule, next_run, status, created_at).
// The old db.ts CREATE declared the retired Telegram-era schema
// (chat_id NOT NULL, no agent/type/description, status CHECK IN('active','paused')),
// so the very first scheduler INSERT boot-crashed with
//   "table scheduled_tasks has no column named agent".
// Prod never hit it because its table had been rebuilt to the agent/type schema
// long ago -- a drift that only a genuinely fresh DB exposes. These tests pin
// the reconciled CREATE to the live schema so a clean-room boot survives.

function freshDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sched-schema-'))
  const path = join(dir, 'fresh.db')
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// Exact column list the live scheduler INSERT targets (noa-scheduler.ts).
const SCHEDULER_INSERT = `
  INSERT INTO scheduled_tasks (id, agent, type, description, prompt, schedule, next_run, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`

describe('scheduled_tasks fresh-DB schema reconciliation (card b38c3231)', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { while (cleanups.length) cleanups.pop()!() })

  function initFresh() {
    const { path, cleanup } = freshDb()
    cleanups.push(cleanup)
    initDatabase(path)
    return getDb()
  }

  it('a clean-room boot INSERT (agent/type shape) succeeds -- reproduces the boot-crash', () => {
    const db = initFresh()
    // Scheduler applies the B-block columns at boot; mirror that order.
    applyBBlockColumns(db)
    const now = Math.floor(Date.now() / 1000)
    expect(() =>
      db.prepare(SCHEDULER_INSERT).run('morning-brief', 'dave', 'task', 'desc', 'do it', '0 9 * * *', now, 'active', now)
    ).not.toThrow()
    const row = db.prepare('SELECT agent, type FROM scheduled_tasks WHERE id = ?').get('morning-brief') as { agent: string; type: string }
    expect(row.agent).toBe('dave')
    expect(row.type).toBe('task')
  })

  it('fresh schema has the live agent/type/description columns and no retired chat_id', () => {
    const db = initFresh()
    const names = new Set((db.prepare('PRAGMA table_info(scheduled_tasks)').all() as Array<{ name: string }>).map(r => r.name))
    expect(names.has('agent')).toBe(true)
    expect(names.has('type')).toBe(true)
    expect(names.has('description')).toBe(true)
    expect(names.has('chat_id')).toBe(false)
  })

  it("status accepts the live 'deleted' value (no narrow CHECK that prod lacks)", () => {
    const db = initFresh()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(SCHEDULER_INSERT).run('gone', 'dave', 'task', '', 'x', '0 9 * * *', now, 'active', now)
    expect(() =>
      db.prepare("UPDATE scheduled_tasks SET status = 'deleted' WHERE id = ?").run('gone')
    ).not.toThrow()
    const row = db.prepare('SELECT status FROM scheduled_tasks WHERE id = ?').get('gone') as { status: string }
    expect(row.status).toBe('deleted')
  })

  it('applyBBlockColumns is idempotent on the reconciled CREATE (all B-block cols present, no throw)', () => {
    const db = initFresh()
    expect(() => { applyBBlockColumns(db); applyBBlockColumns(db) }).not.toThrow()
    const names = new Set((db.prepare('PRAGMA table_info(scheduled_tasks)').all() as Array<{ name: string }>).map(r => r.name))
    for (const c of ['skip_if_busy', 'force_send', 'direct_send', 'layer2', 'target_session', 'card_id']) {
      expect(names.has(c)).toBe(true)
    }
  })
})
