import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
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
    for (const c of ['skip_if_busy', 'force_send', 'direct_send', 'layer2', 'target_session', 'card_id', 'one_shot']) {
      expect(names.has(c)).toBe(true)
    }
  })

  it('one_shot column exists in fresh schema with DEFAULT 0 (card 9b8708d8)', () => {
    const db = initFresh()
    const cols = db.prepare('PRAGMA table_info(scheduled_tasks)').all() as Array<{ name: string; dflt_value: string | null; notnull: number }>
    const col = cols.find(c => c.name === 'one_shot')
    expect(col).toBeDefined()
    expect(col!.dflt_value).toBe('0')
    expect(col!.notnull).toBe(1)
  })

  it('one_shot column added idempotently by applyBBlockColumns on a DB missing it', () => {
    // Simulate an older DB that was created before the one_shot column was added.
    // Use better-sqlite3 directly to build an old-schema table (no one_shot),
    // then verify applyBBlockColumns adds it cleanly and idempotently.
    const { path, cleanup } = freshDb()
    cleanups.push(cleanup)
    const oldDb = new Database(path)
    oldDb.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        type TEXT NOT NULL,
        description TEXT,
        prompt TEXT NOT NULL,
        schedule TEXT NOT NULL,
        next_run INTEGER NOT NULL,
        last_run INTEGER,
        last_result TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        skip_if_busy INTEGER NOT NULL DEFAULT 0,
        force_send INTEGER NOT NULL DEFAULT 0,
        direct_send INTEGER NOT NULL DEFAULT 0,
        layer2 INTEGER NOT NULL DEFAULT 0,
        target_session TEXT,
        card_id TEXT
      )
    `)
    // Verify one_shot is absent before migration
    const before = new Set((oldDb.prepare('PRAGMA table_info(scheduled_tasks)').all() as Array<{ name: string }>).map(r => r.name))
    expect(before.has('one_shot')).toBe(false)
    // Apply B-block columns (should add one_shot without throwing)
    expect(() => applyBBlockColumns(oldDb as unknown as ReturnType<typeof getDb>)).not.toThrow()
    // Verify one_shot is now present
    const after = new Set((oldDb.prepare('PRAGMA table_info(scheduled_tasks)').all() as Array<{ name: string }>).map(r => r.name))
    expect(after.has('one_shot')).toBe(true)
    // Idempotent: second apply must not throw
    expect(() => applyBBlockColumns(oldDb as unknown as ReturnType<typeof getDb>)).not.toThrow()
    oldDb.close()
  })
})
