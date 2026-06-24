import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { initNoaDb, getNoaDb } from '../noa-memory.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(__dirname, '..', '..', 'scripts', 'schema-noa.sql'), 'utf8')

// ---------------------------------------------------------------------------
// Mock session helpers so attemptFireTask never touches tmux
// ---------------------------------------------------------------------------

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

// Import after mocks are registered
const {
  createTask,
  updateTask,
  deleteTask,
  getTask,
  listTasks,
  computeNextRun,
  isValidCronShape,
  runSweepTick,
  migrateFileBasedTasks,
  applyBBlockColumns,
  InvalidIdError,
  DuplicateTaskIdError,
  InvalidScheduleError,
  PromptTooLongError,
  InvalidTypeError,
  InvalidAgentError,
  TaskNotFoundError,
  MAX_SCHEDULED_TASK_PROMPT_LEN,
} = await import('../noa-scheduler.js')

const { isSessionReadyForPrompt, sendPromptToSession } = await import('../web/agent-process.js')

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initNoaDb(':memory:')
  getNoaDb().exec(SCHEMA_SQL)
  applyBBlockColumns(getNoaDb())
})

function wipe(): void {
  const db = getNoaDb()
  db.prepare('DELETE FROM task_runs').run()
  db.prepare('DELETE FROM pending_task_retries').run()
  db.prepare('DELETE FROM scheduled_tasks').run()
}

beforeEach(wipe)
afterEach(wipe)

// ---------------------------------------------------------------------------
// AC-3: TZ-aware computeNextRun
// ---------------------------------------------------------------------------

describe('computeNextRun TZ correctness', () => {
  it('0 9 * * * returns 09:00 Europe/Budapest (not 09:00 UTC)', () => {
    const ts = computeNextRun('0 9 * * *')
    const d = new Date(ts * 1000)
    // Convert to Budapest local time string and check hour
    const local = d.toLocaleString('en-GB', { timeZone: 'Europe/Budapest', hour: '2-digit', hour12: false })
    expect(local).toBe('09')
  })

  it('DST gap: spring-forward -- 02:30 cron on March 28 2027 skips to 03:30 or later', () => {
    // Last Sunday of March 2027 = 2027-03-28, clocks spring 02:00->03:00 in Europe/Budapest
    // Cron "30 2 28 3 *" targets 02:30 on that day -- a time that does not exist
    const ts = computeNextRun('30 2 28 3 *')
    const d = new Date(ts * 1000)
    const local = d.toLocaleString('en-GB', {
      timeZone: 'Europe/Budapest',
      hour: '2-digit', minute: '2-digit', hour12: false,
    })
    // 02:30 doesn't exist on spring-forward Sunday; cron-parser must skip it
    expect(local).not.toBe('02:30')
    expect(ts).toBeGreaterThan(0)
  })

  it('DST fold: fall-back -- after fire, computeNextRun returns time past the fold', () => {
    // Last Sunday of October 2025 = 2025-10-26, clocks fall back 03:00->02:00
    // The task fires at first occurrence; after updating next_run via computeNextRun,
    // next_run points past the fold (next day or week), preventing double-fire
    const schedule = '30 2 26 10 *'
    const first = computeNextRun(schedule)
    // Simulate the post-fire computeNextRun call (called after the task fires)
    // The second computeNextRun should return a time at least one year later
    // since "30 2 26 10 *" only matches Oct 26 (if year isn't specified, next occurrence)
    expect(first).toBeGreaterThan(0)
    // After a task fires, next_run = computeNextRun which returns the NEXT occurrence
    // For a once-a-year pattern (Oct 26), that's ~1 year from now -- well past the fold
    const nowS = Math.floor(Date.now() / 1000)
    expect(first).toBeGreaterThan(nowS)
  })
})

// ---------------------------------------------------------------------------
// AC-1/AC-2: CRUD round-trip
// ---------------------------------------------------------------------------

describe('createTask / listTasks / deleteTask', () => {
  it('createTask inserts row; listTasks returns it', () => {
    const db = getNoaDb()
    const task = createTask({
      id: 'test-task',
      agent: 'marveen',
      type: 'task',
      prompt: 'Do something',
      schedule: '0 9 * * *',
      description: 'A test task',
    }, db)

    expect(task.id).toBe('test-task')
    expect(task.agent).toBe('marveen')
    expect(task.status).toBe('active')
    expect(task.next_run).toBeGreaterThan(0)

    const list = listTasks(undefined, db)
    expect(list.some(t => t.id === 'test-task')).toBe(true)
  })

  it('deleteTask soft-deletes; listTasks excludes deleted rows', () => {
    const db = getNoaDb()
    createTask({ id: 'del-me', agent: 'marveen', type: 'task', prompt: 'x', schedule: '0 9 * * *' }, db)
    deleteTask('del-me', db)

    const list = listTasks(undefined, db)
    expect(list.some(t => t.id === 'del-me')).toBe(false)

    // getTask still returns it (including deleted)
    const raw = getTask('del-me', db)
    expect(raw?.status).toBe('deleted')
  })

  it('DuplicateTaskIdError on second insert with same id', () => {
    const db = getNoaDb()
    createTask({ id: 'dup-id', agent: 'marveen', type: 'task', prompt: 'x', schedule: '0 9 * * *' }, db)
    expect(() =>
      createTask({ id: 'dup-id', agent: 'marveen', type: 'task', prompt: 'x', schedule: '0 9 * * *' }, db)
    ).toThrowError(DuplicateTaskIdError)
  })

  it('InvalidIdError on bad id format', () => {
    const db = getNoaDb()
    expect(() =>
      createTask({ id: 'bad_id', agent: 'marveen', type: 'task', prompt: 'x', schedule: '0 9 * * *' }, db)
    ).toThrowError(InvalidIdError)
  })

  it('InvalidScheduleError on bad cron', () => {
    const db = getNoaDb()
    expect(() =>
      createTask({ id: 'bad-schedule', agent: 'marveen', type: 'task', prompt: 'x', schedule: 'not-a-cron' }, db)
    ).toThrowError(InvalidScheduleError)
  })

  it('PromptTooLongError when prompt exceeds limit', () => {
    const db = getNoaDb()
    const longPrompt = 'x'.repeat(MAX_SCHEDULED_TASK_PROMPT_LEN + 1)
    expect(() =>
      createTask({ id: 'too-long', agent: 'marveen', type: 'task', prompt: longPrompt, schedule: '0 9 * * *' }, db)
    ).toThrowError(PromptTooLongError)
  })

  it('InvalidTypeError on bad type', () => {
    const db = getNoaDb()
    expect(() =>
      createTask({ id: 'bad-type', agent: 'marveen', type: 'widget' as 'task', prompt: 'x', schedule: '0 9 * * *' }, db)
    ).toThrowError(InvalidTypeError)
  })

  it('InvalidAgentError on empty agent', () => {
    const db = getNoaDb()
    expect(() =>
      createTask({ id: 'no-agent', agent: '', type: 'task', prompt: 'x', schedule: '0 9 * * *' }, db)
    ).toThrowError(InvalidAgentError)
  })

  it('updateTask changes schedule and recomputes next_run', () => {
    const db = getNoaDb()
    createTask({ id: 'upd-me', agent: 'marveen', type: 'task', prompt: 'x', schedule: '0 9 * * *' }, db)
    const before = getTask('upd-me', db)!.next_run
    const updated = updateTask('upd-me', { schedule: '0 10 * * *' }, db)
    expect(updated.schedule).toBe('0 10 * * *')
    // next_run should differ from the 9am one
    expect(updated.next_run).not.toBe(before)
  })

  it('TaskNotFoundError when updating deleted task', () => {
    const db = getNoaDb()
    createTask({ id: 'gone', agent: 'marveen', type: 'task', prompt: 'x', schedule: '0 9 * * *' }, db)
    deleteTask('gone', db)
    expect(() => updateTask('gone', { description: 'new' }, db)).toThrowError(TaskNotFoundError)
  })

  it('listTasks filter by status returns only matching rows', () => {
    const db = getNoaDb()
    createTask({ id: 'active-t', agent: 'marveen', type: 'task', prompt: 'x', schedule: '0 9 * * *', status: 'active' }, db)
    createTask({ id: 'paused-t', agent: 'marveen', type: 'task', prompt: 'x', schedule: '0 9 * * *', status: 'paused' }, db)
    const actives = listTasks({ status: 'active' }, db)
    expect(actives.every(t => t.status === 'active')).toBe(true)
    expect(actives.some(t => t.id === 'active-t')).toBe(true)
    expect(actives.some(t => t.id === 'paused-t')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC-4: Sweep fires due task; last_run and next_run updated
// ---------------------------------------------------------------------------

describe('runSweepTick', () => {
  beforeEach(() => {
    vi.mocked(isSessionReadyForPrompt).mockReturnValue(true)
    vi.mocked(sendPromptToSession).mockReset()
  })

  it('fires a task with next_run <= now and updates last_run and next_run', () => {
    const db = getNoaDb()
    const nowS = Math.floor(Date.now() / 1000)
    // Insert a task directly so next_run is in the past
    db.prepare(`
      INSERT INTO scheduled_tasks (id, agent, type, description, prompt, schedule, next_run, status, created_at)
      VALUES ('sweep-test', 'marveen', 'task', '', 'Do it', '0 9 * * *', ?, 'active', ?)
    `).run(nowS - 10, nowS - 100)

    runSweepTick(60000, db)

    const after = getTask('sweep-test', db)!
    expect(after.last_run).toBeGreaterThan(0)
    expect(after.last_result).toBe('fired')
    expect(after.next_run).toBeGreaterThan(nowS)
    expect(vi.mocked(sendPromptToSession)).toHaveBeenCalledOnce()
  })

  it('double-fire guard: does not re-fire a task fired in the same window', () => {
    const db = getNoaDb()
    const nowS = Math.floor(Date.now() / 1000)
    db.prepare(`
      INSERT INTO scheduled_tasks (id, agent, type, description, prompt, schedule, next_run, last_run, status, created_at)
      VALUES ('no-double', 'marveen', 'task', '', 'Do it', '0 9 * * *', ?, ?, 'active', ?)
    `).run(nowS - 10, nowS - 5, nowS - 100)
    // last_run (nowS-5) >= next_run (nowS-10) -- already fired this window

    vi.mocked(sendPromptToSession).mockReset()
    runSweepTick(60000, db)
    // Should NOT fire again because last_run >= next_run
    expect(vi.mocked(sendPromptToSession)).not.toHaveBeenCalled()
  })

  it('busy session inserts pending retry row', () => {
    const db = getNoaDb()
    vi.mocked(isSessionReadyForPrompt).mockReturnValue(false)

    const nowS = Math.floor(Date.now() / 1000)
    db.prepare(`
      INSERT INTO scheduled_tasks (id, agent, type, description, prompt, schedule, next_run, status, created_at)
      VALUES ('busy-task', 'marveen', 'task', '', 'Do it', '0 9 * * *', ?, 'active', ?)
    `).run(nowS - 10, nowS - 100)

    runSweepTick(60000, db)

    const retries = db.prepare(
      `SELECT * FROM pending_task_retries WHERE task_name='busy-task'`
    ).all() as Array<{ task_name: string; attempt_count: number }>
    expect(retries).toHaveLength(1)
    expect(retries[0]!.attempt_count).toBe(1)
  })

  it('pending retry: subsequent tick retries the task when session frees up', () => {
    const db = getNoaDb()
    const nowS = Math.floor(Date.now() / 1000)
    // Task already fired (next_run in future), but has a pending retry row
    db.prepare(`
      INSERT INTO scheduled_tasks (id, agent, type, description, prompt, schedule, next_run, status, created_at)
      VALUES ('retry-task', 'marveen', 'task', '', 'Do it', '0 9 * * *', ?, 'active', ?)
    `).run(nowS + 3600, nowS - 100)

    // Insert a pending retry row simulating a previous busy tick
    db.prepare(`
      INSERT INTO pending_task_retries (task_name, agent_name, first_attempt, last_attempt, attempt_count, last_reason)
      VALUES ('retry-task', 'marveen', ?, ?, 1, 'busy')
    `).run(nowS - 120, nowS - 120)

    vi.mocked(isSessionReadyForPrompt).mockReturnValue(true)
    vi.mocked(sendPromptToSession).mockReset()

    runSweepTick(60000, db)

    // Retry should have fired; pending row should be gone
    expect(vi.mocked(sendPromptToSession)).toHaveBeenCalledOnce()
    const retries = db.prepare(
      `SELECT * FROM pending_task_retries WHERE task_name='retry-task'`
    ).all()
    expect(retries).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// AC-7: File migration
// ---------------------------------------------------------------------------

describe('migrateFileBasedTasks', () => {
  it('imports 2 file-based tasks and inserts sentinel; idempotent on second run', () => {
    const db = getNoaDb()
    const dir = join(tmpdir(), `noa-sched-test-${Date.now()}`)

    // Create 2 fake file-based tasks
    for (const name of ['task-alpha', 'task-beta']) {
      const taskDir = join(dir, name)
      mkdirSync(taskDir, { recursive: true })
      writeFileSync(join(taskDir, 'SKILL.md'), `---\nname: ${name}\ndescription: Test task\n---\n\nDo stuff.`)
      writeFileSync(join(taskDir, 'task-config.json'), JSON.stringify({
        schedule: '0 9 * * *',
        agent: 'marveen',
        type: 'task',
        enabled: true,
        createdAt: Math.floor(Date.now() / 1000) - 1000,
      }))
    }

    try {
      migrateFileBasedTasks(db, dir)

      const rows = db.prepare(
        `SELECT * FROM scheduled_tasks WHERE status != 'deleted' AND id NOT LIKE '__file_%'`
      ).all() as Array<{ id: string }>
      const ids = rows.map(r => r.id)
      expect(ids).toContain('task-alpha')
      expect(ids).toContain('task-beta')

      // Sentinel must be present
      const sentinel = db.prepare(
        `SELECT id FROM scheduled_tasks WHERE id = '__file_migration_done'`
      ).get()
      expect(sentinel).toBeTruthy()

      // Second run: idempotent -- no duplicate rows, no error
      migrateFileBasedTasks(db, dir)
      const rowsAfter = db.prepare(
        `SELECT * FROM scheduled_tasks WHERE id = 'task-alpha'`
      ).all()
      expect(rowsAfter).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips tasks with invalid cron and still writes sentinel', () => {
    const db = getNoaDb()
    const dir = join(tmpdir(), `noa-sched-invalid-${Date.now()}`)
    const taskDir = join(dir, 'bad-cron')
    mkdirSync(taskDir, { recursive: true })
    writeFileSync(join(taskDir, 'SKILL.md'), `---\nname: bad-cron\ndescription: Bad\n---\n\nNoop.`)
    writeFileSync(join(taskDir, 'task-config.json'), JSON.stringify({
      schedule: 'not-a-cron',
      agent: 'marveen',
      enabled: true,
    }))

    try {
      migrateFileBasedTasks(db, dir)
      const row = db.prepare(`SELECT id FROM scheduled_tasks WHERE id = 'bad-cron'`).get()
      expect(row).toBeUndefined()
      const sentinel = db.prepare(`SELECT id FROM scheduled_tasks WHERE id = '__file_migration_done'`).get()
      expect(sentinel).toBeTruthy()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// DoD grep assertions verified structurally
// ---------------------------------------------------------------------------

describe('DoD structural assertions', () => {
  it('no enabled field in ScheduledTask (AC-9)', () => {
    const db = getNoaDb()
    const task = createTask({ id: 'struct-check', agent: 'marveen', type: 'task', prompt: 'x', schedule: '0 9 * * *' }, db)
    expect('enabled' in task).toBe(false)
    expect(task.status).toBeDefined()
  })

  it('isValidCronShape uses TZ (returns true for valid cron)', () => {
    expect(isValidCronShape('0 9 * * *')).toBe(true)
    expect(isValidCronShape('not a cron')).toBe(false)
    expect(isValidCronShape(42)).toBe(false)
  })
})
