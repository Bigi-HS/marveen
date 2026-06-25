import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initNoaDb, getNoaDb } from '../noa-memory.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(__dirname, '..', '..', 'scripts', 'schema-noa.sql'), 'utf8')

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: vi.fn().mockReturnValue(true),
  sendPromptToSession: vi.fn(),
  isAgentRunning: vi.fn().mockReturnValue(false),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'marveen-channels',
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: vi.fn().mockReturnValue('marveen-channels\n'),
  }
})

const {
  syncTaskToNoa,
  removeTaskFromNoa,
  updateTask,
  runSweepTick,
  applyBBlockColumns,
} = await import('../noa-scheduler.js')

const { isSessionReadyForPrompt, sendPromptToSession } = await import('../web/agent-process.js')

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initNoaDb(':memory:')
  getNoaDb().exec(SCHEMA_SQL)
  applyBBlockColumns(getNoaDb())
})

function wipe(): void {
  const db = getNoaDb()
  db.prepare('DELETE FROM scheduled_tasks').run()
  db.prepare('DELETE FROM pending_task_retries').run()
  db.prepare('DELETE FROM task_runs').run()
}

// ---------------------------------------------------------------------------
// syncTaskToNoa
// ---------------------------------------------------------------------------

describe('syncTaskToNoa', () => {
  beforeEach(wipe)

  it('new id -> INSERT active row with correct next_run', () => {
    const db = getNoaDb()
    const before = Math.floor(Date.now() / 1000)
    const task = syncTaskToNoa({
      id: 'sync-new',
      agent: 'marveen',
      type: 'task',
      prompt: 'Do something',
      schedule: '0 9 * * *',
    }, db)
    expect(task.id).toBe('sync-new')
    expect(task.status).toBe('active')
    expect(task.next_run).toBeGreaterThan(before)
    const row = db.prepare('SELECT id FROM scheduled_tasks WHERE id = ?').get('sync-new')
    expect(row).toBeTruthy()
  })

  it('existing deleted id -> REVIVE to active without throwing', () => {
    const db = getNoaDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(`
      INSERT INTO scheduled_tasks (id, agent, type, description, prompt, schedule, next_run, status, created_at)
      VALUES ('sync-revive', 'marveen', 'task', '', 'Old prompt', '0 8 * * *', ?, 'deleted', ?)
    `).run(now - 100, now - 200)

    let task!: ReturnType<typeof syncTaskToNoa>
    expect(() => {
      task = syncTaskToNoa({
        id: 'sync-revive',
        agent: 'marveen',
        type: 'task',
        prompt: 'New prompt',
        schedule: '0 10 * * *',
      }, db)
    }).not.toThrow()
    expect(task.status).toBe('active')
    expect(task.prompt).toBe('New prompt')
    expect(task.schedule).toBe('0 10 * * *')
  })

  it('existing active id -> UPDATE fields and recalculate next_run', () => {
    const db = getNoaDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(`
      INSERT INTO scheduled_tasks (id, agent, type, description, prompt, schedule, next_run, status, created_at)
      VALUES ('sync-update', 'marveen', 'task', 'Old desc', 'Old prompt', '0 8 * * *', ?, 'active', ?)
    `).run(now + 3600, now - 100)

    const task = syncTaskToNoa({
      id: 'sync-update',
      agent: 'marveen',
      type: 'heartbeat',
      prompt: 'Updated prompt',
      schedule: '0 12 * * *',
      description: 'New desc',
    }, db)
    expect(task.prompt).toBe('Updated prompt')
    expect(task.type).toBe('heartbeat')
    expect(task.description).toBe('New desc')
    expect(task.next_run).not.toBe(now + 3600)
  })
})

// ---------------------------------------------------------------------------
// removeTaskFromNoa
// ---------------------------------------------------------------------------

describe('removeTaskFromNoa', () => {
  beforeEach(wipe)

  it('existing task -> soft-delete (status=deleted)', () => {
    const db = getNoaDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(`
      INSERT INTO scheduled_tasks (id, agent, type, description, prompt, schedule, next_run, status, created_at)
      VALUES ('rm-task', 'marveen', 'task', '', 'Do it', '0 9 * * *', ?, 'active', ?)
    `).run(now + 100, now - 100)

    removeTaskFromNoa('rm-task', db)

    const row = db.prepare('SELECT status FROM scheduled_tasks WHERE id = ?').get('rm-task') as { status: string }
    expect(row.status).toBe('deleted')
  })

  it('missing id -> no-op (does not throw)', () => {
    const db = getNoaDb()
    expect(() => removeTaskFromNoa('not-exist', db)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// REGRESSION: sweep respects dualwrite state (core requirement)
// ---------------------------------------------------------------------------

describe('regression: sweep respects dualwrite state', () => {
  beforeEach(() => {
    wipe()
    vi.mocked(isSessionReadyForPrompt).mockReturnValue(true)
    vi.mocked(sendPromptToSession).mockReset()
  })

  it('removeTaskFromNoa -> runSweepTick does NOT fire the deleted task', () => {
    const db = getNoaDb()
    const nowS = Math.floor(Date.now() / 1000)
    db.prepare(`
      INSERT INTO scheduled_tasks (id, agent, type, description, prompt, schedule, next_run, status, created_at)
      VALUES ('removed-task', 'marveen', 'task', '', 'Do it', '0 9 * * *', ?, 'active', ?)
    `).run(nowS - 10, nowS - 100)

    removeTaskFromNoa('removed-task', db)
    runSweepTick(60000, db)

    expect(vi.mocked(sendPromptToSession)).not.toHaveBeenCalled()
  })

  it('syncTaskToNoa (create) -> runSweepTick fires without restart', () => {
    const db = getNoaDb()
    syncTaskToNoa({
      id: 'sync-and-fire',
      agent: 'marveen',
      type: 'task',
      prompt: 'Fire me',
      schedule: '0 9 * * *',
    }, db)
    // Force next_run into the past so the sweep picks it up immediately
    const nowS = Math.floor(Date.now() / 1000)
    db.prepare('UPDATE scheduled_tasks SET next_run = ? WHERE id = ?').run(nowS - 10, 'sync-and-fire')

    runSweepTick(60000, db)

    expect(vi.mocked(sendPromptToSession)).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// updateTask: PUT schedule-change + toggle pause (routes behaviour via DB layer)
// ---------------------------------------------------------------------------

describe('updateTask for PUT schedule-change and toggle', () => {
  beforeEach(wipe)

  it('schedule-change -> next_run recalculated', () => {
    const db = getNoaDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(`
      INSERT INTO scheduled_tasks (id, agent, type, description, prompt, schedule, next_run, status, created_at)
      VALUES ('put-sched', 'marveen', 'task', '', 'Do it', '0 8 * * *', ?, 'active', ?)
    `).run(now + 100, now - 100)

    const before = (db.prepare('SELECT next_run FROM scheduled_tasks WHERE id = ?').get('put-sched') as { next_run: number }).next_run
    updateTask('put-sched', { schedule: '0 18 * * *' }, db)
    const after = (db.prepare('SELECT next_run FROM scheduled_tasks WHERE id = ?').get('put-sched') as { next_run: number }).next_run
    expect(after).not.toBe(before)
  })

  it('toggle pause -> status=paused -> sweep skips task', () => {
    const db = getNoaDb()
    const nowS = Math.floor(Date.now() / 1000)
    db.prepare(`
      INSERT INTO scheduled_tasks (id, agent, type, description, prompt, schedule, next_run, status, created_at)
      VALUES ('toggle-task', 'marveen', 'task', '', 'Do it', '0 9 * * *', ?, 'active', ?)
    `).run(nowS - 10, nowS - 100)

    updateTask('toggle-task', { status: 'paused' }, db)
    vi.mocked(sendPromptToSession).mockReset()
    runSweepTick(60000, db)

    expect(vi.mocked(sendPromptToSession)).not.toHaveBeenCalled()
  })
})
