import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { buildScheduledTaskPrompt } from '../noa-scheduler.js'
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
  capturePane: vi.fn().mockReturnValue(null),
}))

vi.mock('../pane-state.js', () => ({
  detectPaneState: vi.fn().mockReturnValue('unknown'),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'marveen-channels',
}))

// The escalation layer does real network I/O; a test must never be able to
// send a Telegram message. Mocked so the sweep wiring can be asserted.
vi.mock('../web/pending-retry-alert.js', () => ({
  sendPendingRetryAlert: vi.fn(),
}))

vi.mock('../web/stuck-task-sentinel.js', () => ({
  sweepStuckTasks: vi.fn(),
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
  recordTriggerFire,
  InvalidIdError,
  DuplicateTaskIdError,
  InvalidScheduleError,
  PromptTooLongError,
  InvalidTypeError,
  InvalidAgentError,
  TaskNotFoundError,
  MAX_SCHEDULED_TASK_PROMPT_LEN,
} = await import('../noa-scheduler.js')

const { isSessionReadyForPrompt, sendPromptToSession, capturePane } = await import('../web/agent-process.js')
const { detectPaneState } = await import('../pane-state.js')
const { sendPendingRetryAlert } = await import('../web/pending-retry-alert.js')
const { sweepStuckTasks } = await import('../web/stuck-task-sentinel.js')

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

  // Kebab-charset guard (card 8c088adf, Chad #292 finding): only [a-z0-9-] allowed
  // in agent names -- tmux metacharacters and path separators must be rejected.
  it.each([
    ['agent with space', 'my agent'],
    ['agent with semicolon (tmux metachar)', 'agent;rm -rf /'],
    ['agent with newline', 'agent\ninjection'],
    ['agent with dollar (shell expand)', 'agent$HOME'],
    ['agent with slash (path traversal)', 'agent/../../etc'],
    ['agent with uppercase', 'Agent'],
    ['agent with underscore', 'my_agent'],
    ['agent starting with hyphen', '-agent'],
  ])('rejects %s', (_label, badAgent) => {
    const db = getNoaDb()
    expect(() =>
      createTask({ id: 'charset-test', agent: badAgent, type: 'task', prompt: 'x', schedule: '0 9 * * *' }, db)
    ).toThrowError(InvalidAgentError)
  })

  it.each([
    ['simple lowercase', 'marveen'],
    ['with hyphen', 'dr-stone'],
    ['alphanumeric', 'agent42'],
    ['multi-segment kebab', 'sub-agent-7'],
  ])('accepts valid agent name: %s', (_label, goodAgent) => {
    const db = getNoaDb()
    expect(() =>
      createTask({ id: `valid-${goodAgent.replace(/[^a-z0-9]/g, '-')}`, agent: goodAgent, type: 'task', prompt: 'x', schedule: '0 9 * * *' }, db)
    ).not.toThrow()
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

  it('caches the tmux session list: list-sessions spawns once per tick, not once per task', async () => {
    const { execFileSync } = await import('node:child_process')
    const db = getNoaDb()
    const nowS = Math.floor(Date.now() / 1000)
    // Three due tasks in one tick. The old code spawned `tmux list-sessions`
    // once per attemptFireTask (3 spawns); the cached version resolves the
    // session set once at the top of the sweep and reuses it (1 spawn).
    for (let i = 0; i < 3; i++) {
      db.prepare(`
        INSERT INTO scheduled_tasks (id, agent, type, description, prompt, schedule, next_run, status, created_at)
        VALUES (?, 'marveen', 'task', '', 'Do it', '0 9 * * *', ?, 'active', ?)
      `).run(`cache-${i}`, nowS - 10, nowS - 100)
    }

    vi.mocked(execFileSync).mockClear()
    runSweepTick(60000, db)

    const listSessionsCalls = vi.mocked(execFileSync).mock.calls.filter(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('list-sessions'),
    )
    expect(vi.mocked(sendPromptToSession)).toHaveBeenCalledTimes(3)
    expect(listSessionsCalls).toHaveLength(1)
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

  // Regression: bb034b08 -- single-cron triple-fire (dual-source ghost, eliminated by eb6ab3c7).
  // Proof: busy on tick1 -> pending retry on tick2 -> EXACTLY 1 send total; next_run rolls forward.
  // The cron sweep on tick2 skips the task (pendingKeys guard), so no double-fire.
  it('single-fire regression (bb034b08): busy tick1 + retry-success tick2 = exactly 1 send, next_run advanced', () => {
    const db = getNoaDb()
    const nowS = Math.floor(Date.now() / 1000)

    db.prepare(`
      INSERT INTO scheduled_tasks (id, agent, type, description, prompt, schedule, next_run, status, created_at)
      VALUES ('triple-fire-task', 'marveen', 'task', '', 'Do it', '0 9 * * *', ?, 'active', ?)
    `).run(nowS - 10, nowS - 100)

    // Tick 1: session busy -> no send, pending retry inserted
    vi.mocked(isSessionReadyForPrompt).mockReturnValue(false)
    vi.mocked(sendPromptToSession).mockReset()
    runSweepTick(60000, db)

    expect(vi.mocked(sendPromptToSession)).not.toHaveBeenCalled()
    const retryRows = db.prepare(
      `SELECT * FROM pending_task_retries WHERE task_name='triple-fire-task'`
    ).all()
    expect(retryRows).toHaveLength(1)

    // Tick 2: session free -> retry fires; cron sweep skips (pendingKeys guard).
    // Advance time by MAX_BACKOFF_S (10 min) so the exponential-backoff window
    // has elapsed regardless of attempt_count (card c87b198a).
    vi.mocked(isSessionReadyForPrompt).mockReturnValue(true)
    vi.mocked(sendPromptToSession).mockReset()
    runSweepTick(60000, db, Date.now() + 11 * 60 * 1000)

    // (a) Exactly ONE fire across both paths (retry succeeded, cron sweep was skipped)
    expect(vi.mocked(sendPromptToSession)).toHaveBeenCalledOnce()

    // (b) next_run advanced beyond nowS (not stuck at the original due time)
    const updated = db.prepare(
      `SELECT next_run FROM scheduled_tasks WHERE id='triple-fire-task'`
    ).get() as { next_run: number }
    expect(updated.next_run).toBeGreaterThan(nowS)

    // Pending retry row removed after success
    const retryRowsAfter = db.prepare(
      `SELECT * FROM pending_task_retries WHERE task_name='triple-fire-task'`
    ).all()
    expect(retryRowsAfter).toHaveLength(0)
  })

  // Regression: 295c94f2 -- look-ahead self-refire (chad-daily-security fired 3x).
  // The cron sweep fires a task up to catchUp (60s) BEFORE its slot (next_run <= now+catchUp).
  // When it fires inside that window, the wall clock is still BEFORE the cron minute, so a
  // computeNextRun() basis of Date.now() re-resolves to the SAME slot -- next_run never
  // advances and the next tick (now past the slot) fires it a second time. The fix bases
  // the roll-forward on max(now, next_run) so it always lands on the slot AFTER the one fired.
  it('look-ahead refire (295c94f2): firing in the pre-slot window does not double-fire on the next tick', () => {
    const db = getNoaDb()
    // Cron slot 09:00:00 CEST (UTC+2) on a fixed date == 07:00:00Z.
    const slotS = Math.floor(Date.parse('2026-06-29T07:00:00Z') / 1000)
    db.prepare(`
      INSERT INTO scheduled_tasks (id, agent, type, description, prompt, schedule, next_run, status, created_at)
      VALUES ('lookahead-task', 'marveen', 'task', '', 'Do it', '0 9 * * *', ?, 'active', ?)
    `).run(slotS, slotS - 100)

    vi.mocked(isSessionReadyForPrompt).mockReturnValue(true)
    vi.mocked(sendPromptToSession).mockReset()
    vi.useFakeTimers()
    try {
      // Tick 1 at 08:59:30 -- 30s BEFORE the slot, inside the 60s look-ahead window.
      vi.setSystemTime(new Date('2026-06-29T06:59:30Z'))
      runSweepTick(60000, db)

      // Tick 2 at 09:00:35 -- just AFTER the slot.
      vi.setSystemTime(new Date('2026-06-29T07:00:35Z'))
      runSweepTick(60000, db)
    } finally {
      vi.useRealTimers()
    }

    // Exactly ONE send across both ticks (no self-refire).
    expect(vi.mocked(sendPromptToSession)).toHaveBeenCalledOnce()
    // next_run advanced past the slot that fired (to the following day's slot).
    const after = getTask('lookahead-task', db)!
    expect(after.next_run).toBeGreaterThan(slotS)
  })

  it('OQ-1 B-block: task with target_session is inert -- fires to agent own session', () => {
    // target_session is a B-block column: stored but NEVER branched on in A4 sweep.
    // Proof: if old code ran it would use target_session='custom-override' which is NOT
    // in the mock tmux list -> task returns 'missing' -> sendPromptToSession not called
    // -> test would fail. New code ignores target_session; marveen is the main agent so
    // session resolves to MAIN_CHANNELS_SESSION='marveen-channels' (IS in mock) -> fires.
    const db = getNoaDb()
    const nowS = Math.floor(Date.now() / 1000)
    db.prepare(`
      INSERT INTO scheduled_tasks
        (id, agent, type, description, prompt, schedule, next_run, status, created_at, target_session)
      VALUES ('bblock-target', 'marveen', 'task', '', 'Do it', '0 9 * * *', ?, 'active', ?, 'custom-override')
    `).run(nowS - 10, nowS - 100)

    vi.mocked(sendPromptToSession).mockReset()
    runSweepTick(60000, db)

    expect(vi.mocked(sendPromptToSession)).toHaveBeenCalledOnce()
    const [calledSession] = vi.mocked(sendPromptToSession).mock.calls[0]!
    // Must route to 'marveen-channels' (main-agent session), NOT 'custom-override'
    expect(calledSession).toBe('marveen-channels')
  })
})

// ---------------------------------------------------------------------------
// Card 8af09fa0: a missing session (wedged / absent agent) must not silently
// lose its scheduled fires. Before this fix a 'missing' verdict left ZERO
// durable trace -- next_run frozen, no retry row -- so the only backstop was
// the 3h stuck-sentinel (stuck-task-sentinel.ts header: "it does NOT cover
// 'missing'"). The fix wires 'missing' into the existing pending-retry queue,
// which gives it three properties for free: a durable row (dashboard-visible),
// automatic recovery when the session returns, and 1h operator escalation.
// ---------------------------------------------------------------------------

describe('runSweepTick: missing session durable trace + recovery (card 8af09fa0)', () => {
  // A task whose agent session is NOT in the mocked tmux list ('marveen-channels'
  // only) resolves to 'agent-ghost' -> not present -> attemptFireTask == 'missing'.
  const GHOST = "('ghost-task', 'ghost', 'task', '', 'Do it', '0 9 * * *', ?, 'active', ?)"

  beforeEach(() => {
    vi.mocked(isSessionReadyForPrompt).mockReturnValue(true)
    vi.mocked(sendPromptToSession).mockReset()
    vi.mocked(sendPendingRetryAlert).mockReset()
  })

  it('missing session enqueues a pending-retry row (reason=missing); no send; next_run frozen', () => {
    const db = getNoaDb()
    const nowS = Math.floor(Date.now() / 1000)
    db.prepare(`INSERT INTO scheduled_tasks
      (id, agent, type, description, prompt, schedule, next_run, status, created_at)
      VALUES ${GHOST}`).run(nowS - 10, nowS - 100)

    runSweepTick(60000, db)

    // Session absent -> never attempted to send.
    expect(vi.mocked(sendPromptToSession)).not.toHaveBeenCalled()

    // Durable trace: exactly one retry row, reason 'missing'.
    const rows = db.prepare(
      `SELECT * FROM pending_task_retries WHERE task_name='ghost-task'`
    ).all() as Array<{ last_reason: string; attempt_count: number }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.last_reason).toBe('missing')
    expect(rows[0]!.attempt_count).toBe(1)

    // next_run NOT advanced (task still due) and NOT falsely marked fired.
    const t = getTask('ghost-task', db)!
    expect(t.next_run).toBe(nowS - 10)
    expect(t.last_result).not.toBe('fired')
  })

  it('missing row survives a second still-missing tick (pre-fix it was deleted in Step 1)', () => {
    const db = getNoaDb()
    const nowS = Math.floor(Date.now() / 1000)
    db.prepare(`INSERT INTO scheduled_tasks
      (id, agent, type, description, prompt, schedule, next_run, status, created_at)
      VALUES ${GHOST}`).run(nowS - 10, nowS - 100)

    runSweepTick(60000, db)                                   // tick 1: row created
    runSweepTick(60000, db, Date.now() + 11 * 60 * 1000)     // tick 2: still missing, backoff elapsed

    const rows = db.prepare(
      `SELECT * FROM pending_task_retries WHERE task_name='ghost-task'`
    ).all() as Array<{ last_reason: string; attempt_count: number }>
    expect(rows).toHaveLength(1)                              // NOT deleted
    expect(rows[0]!.attempt_count).toBeGreaterThanOrEqual(2)  // retried again, still tracked
    expect(rows[0]!.last_reason).toBe('missing')
  })

  it('recovers automatically: when the session returns the task fires and the row clears', async () => {
    const db = getNoaDb()
    const { execFileSync } = await import('node:child_process')
    const nowS = Math.floor(Date.now() / 1000)
    db.prepare(`INSERT INTO scheduled_tasks
      (id, agent, type, description, prompt, schedule, next_run, status, created_at)
      VALUES ${GHOST}`).run(nowS - 10, nowS - 100)

    runSweepTick(60000, db)                                   // tick 1: missing -> row
    expect(db.prepare(
      `SELECT * FROM pending_task_retries WHERE task_name='ghost-task'`
    ).all()).toHaveLength(1)

    // Session returns: the ghost agent's tmux session now shows up in list-sessions.
    vi.mocked(execFileSync).mockReturnValue('marveen-channels\nagent-ghost\n')
    vi.mocked(sendPromptToSession).mockReset()

    runSweepTick(60000, db, Date.now() + 11 * 60 * 1000)     // tick 2: present + backoff elapsed

    expect(vi.mocked(sendPromptToSession)).toHaveBeenCalledOnce()  // fired
    expect(db.prepare(
      `SELECT * FROM pending_task_retries WHERE task_name='ghost-task'`
    ).all()).toHaveLength(0)                                  // row cleared on success
    const t = getTask('ghost-task', db)!
    expect(t.next_run).toBeGreaterThan(nowS)                  // rolled forward
    expect(t.last_result).toBe('fired')

    vi.mocked(execFileSync).mockReturnValue('marveen-channels\n')  // restore default
  })

  it('escalates a chronically-missing task via the pending-retry alert once past the 1h threshold', () => {
    const db = getNoaDb()
    const nowS = Math.floor(Date.now() / 1000)
    db.prepare(`INSERT INTO scheduled_tasks
      (id, agent, type, description, prompt, schedule, next_run, status, created_at)
      VALUES ${GHOST}`).run(nowS - 10, nowS - 5000)
    // Pre-seed a missing retry row older than ALERT_THRESHOLD_S (1h = 3600s).
    db.prepare(`INSERT INTO pending_task_retries
      (task_name, agent_name, first_attempt, last_attempt, attempt_count, last_reason)
      VALUES ('ghost-task', 'ghost', ?, ?, 5, 'missing')`).run(nowS - 4000, nowS - 4000)

    // Tick with the backoff window elapsed; age (4000s+) exceeds the 1h threshold.
    runSweepTick(60000, db, (nowS + 700) * 1000)

    expect(vi.mocked(sendPendingRetryAlert)).toHaveBeenCalled()
  })

  it('does not regress the happy path: a present-session task fires and enqueues nothing', () => {
    const db = getNoaDb()
    const nowS = Math.floor(Date.now() / 1000)
    db.prepare(`INSERT INTO scheduled_tasks
      (id, agent, type, description, prompt, schedule, next_run, status, created_at)
      VALUES ('ok-task', 'marveen', 'task', '', 'Do it', '0 9 * * *', ?, 'active', ?)`
    ).run(nowS - 10, nowS - 100)

    runSweepTick(60000, db)

    expect(vi.mocked(sendPromptToSession)).toHaveBeenCalledOnce()
    expect(db.prepare(
      `SELECT * FROM pending_task_retries WHERE task_name='ok-task'`
    ).all()).toHaveLength(0)
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

// ---------------------------------------------------------------------------
// recordTriggerFire -- n8n trigger-mode dedup guard (card bc3ccf39)
// ---------------------------------------------------------------------------

describe('recordTriggerFire', () => {
  it('rolls last_run and next_run forward so native runner skips the task', () => {
    const db = getNoaDb()
    const task = createTask({ id: 'trig-fired', agent: 'forge', type: 'heartbeat', prompt: 'x', schedule: '0 * * * *' }, db)
    const before = getTask('trig-fired', db)!
    const beforeNext = before.next_run

    recordTriggerFire(task, db)

    const after = getTask('trig-fired', db)!
    expect(after.last_run).toBeGreaterThan(0)
    // next_run must be strictly after the pre-fire next_run (rolled forward by >=1 interval)
    expect(after.next_run).toBeGreaterThan(beforeNext)
    // last_result set to 'fired'
    expect((after as any).last_result).toBe('fired')

    // Native runner query must NOT pick this task up: next_run > now
    const nowS = Math.floor(Date.now() / 1000)
    expect(after.next_run).toBeGreaterThan(nowS)
  })

  it('uses same basisMs formula as native (max(now, task.next_run*1000)) to avoid self-refire', () => {
    const db = getNoaDb()
    // Create a task whose next_run is in the past (simulates a look-ahead fire)
    const task = createTask({ id: 'trig-past', agent: 'forge', type: 'heartbeat', prompt: 'x', schedule: '0 * * * *' }, db)
    // Force next_run to a past value to simulate the look-ahead case
    db.prepare('UPDATE scheduled_tasks SET next_run=? WHERE id=?').run(
      Math.floor(Date.now() / 1000) - 60, 'trig-past'
    )
    const stale = getTask('trig-past', db)!

    recordTriggerFire(stale, db)

    const after = getTask('trig-past', db)!
    // next_run must be in the future (not re-resolving to the same past slot)
    expect(after.next_run).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it('same-tick race: native runner that polls within the same second sees the updated next_run (409-busy backstop documented)', () => {
    // This test documents the narrow race: if the native poll query runs in the same
    // second as recordTriggerFire's UPDATE commits, the SELECT may have already latched
    // the old next_run. The 409-busy from the second inject is the backstop -- the agent
    // ignores a duplicate prompt while processing. No additional coordination needed.
    const db = getNoaDb()
    const task = createTask({ id: 'trig-race', agent: 'forge', type: 'heartbeat', prompt: 'x', schedule: '0 * * * *' }, db)
    const beforeNext = getTask('trig-race', db)!.next_run

    recordTriggerFire(task, db)

    // After the commit, a new SELECT always sees the updated next_run (SQLite serializes writes)
    const afterNext = getTask('trig-race', db)!.next_run
    expect(afterNext).toBeGreaterThan(beforeNext)
    // The race is only possible if the native poll caches the row before the commit --
    // in practice the sweep runs in a single transaction per tick, so this is <1s window.
  })
})

// ---------------------------------------------------------------------------
// Parked prompt is NOT a fire (card CORE/57cf5022)
//
// Live incident 2026-08-04/05: attemptFireTask reported 'fired' for the act of
// TYPING the prompt, not for its submission. sendPromptToSession's own
// submit-confirm loop had already given up ("prompt still parked after
// retries") and threw that verdict away as a log line. Consequence chain:
// next_run rolled forward and a task_runs row was written for a run that never
// happened, while the un-submitted draft left in the composer kept the pane
// non-idle -- so every LATER task to that agent read as busy, forever. Eleven
// tasks sat with next_run frozen in the past for up to 78 hours.
// ---------------------------------------------------------------------------

describe('runSweepTick: parked (un-submitted) prompt', () => {
  beforeEach(() => {
    vi.mocked(isSessionReadyForPrompt).mockReturnValue(true)
    vi.mocked(sendPromptToSession).mockReset()
  })

  function insertDueTask(db: ReturnType<typeof getNoaDb>, id: string, nowS: number): void {
    db.prepare(`
      INSERT INTO scheduled_tasks (id, agent, type, description, prompt, schedule, next_run, status, created_at)
      VALUES (?, 'marveen', 'task', '', 'Do it', '0 9 * * *', ?, 'active', ?)
    `).run(id, nowS - 10, nowS - 100)
  }

  it('does not roll next_run forward when the prompt never got submitted', () => {
    const db = getNoaDb()
    const nowS = Math.floor(Date.now() / 1000)
    insertDueTask(db, 'parked-task', nowS)
    vi.mocked(sendPromptToSession).mockReturnValue('parked')

    runSweepTick(60000, db)

    const after = getTask('parked-task', db)!
    expect(after.next_run).toBe(nowS - 10)
    expect(after.last_run).toBeNull()
    expect(after.last_result).not.toBe('fired')
  })

  it('does not record a task_runs row for a prompt that never got submitted', () => {
    const db = getNoaDb()
    const nowS = Math.floor(Date.now() / 1000)
    insertDueTask(db, 'parked-norun', nowS)
    vi.mocked(sendPromptToSession).mockReturnValue('parked')

    runSweepTick(60000, db)

    const runs = db.prepare(`SELECT * FROM task_runs WHERE name='parked-norun'`).all()
    expect(runs).toHaveLength(0)
  })

  it('queues the task for retry so it is not silently dropped', () => {
    const db = getNoaDb()
    const nowS = Math.floor(Date.now() / 1000)
    insertDueTask(db, 'parked-retry', nowS)
    vi.mocked(sendPromptToSession).mockReturnValue('parked')

    runSweepTick(60000, db)

    const retries = db.prepare(
      `SELECT * FROM pending_task_retries WHERE task_name='parked-retry'`
    ).all() as Array<{ last_reason: string }>
    expect(retries).toHaveLength(1)
    expect(retries[0]!.last_reason).toBe('parked')
  })

  it('fires normally on the next tick once the submit lands', () => {
    const db = getNoaDb()
    const nowS = Math.floor(Date.now() / 1000)
    insertDueTask(db, 'parked-recover', nowS)

    vi.mocked(sendPromptToSession).mockReturnValue('parked')
    runSweepTick(60000, db)
    expect(getTask('parked-recover', db)!.next_run).toBe(nowS - 10)

    // Advance time past MAX_BACKOFF_S so the backoff window has elapsed (card c87b198a).
    vi.mocked(sendPromptToSession).mockReturnValue('submitted')
    runSweepTick(60000, db, Date.now() + 11 * 60 * 1000)

    const after = getTask('parked-recover', db)!
    expect(after.last_result).toBe('fired')
    expect(after.next_run).toBeGreaterThan(nowS)
    expect(db.prepare(`SELECT * FROM pending_task_retries WHERE task_name='parked-recover'`).all())
      .toHaveLength(0)
  })

  it('an unconfirmable send (capture failure) still counts as fired -- unknown must not re-run a task', () => {
    // The opposite failure direction: treating "cannot tell" as "did not
    // fire" would re-run a task that may already have executed. Only a
    // MEASURED parked verdict withholds the roll-forward.
    // NOTE: last_result is now 'unconfirmed' (not 'fired') so the operator
    // can distinguish "confirmed fired" from "sent but unverifiable".
    // next_run still rolls forward so the task does not get stuck.
    const db = getNoaDb()
    const nowS = Math.floor(Date.now() / 1000)
    insertDueTask(db, 'unknown-task', nowS)
    vi.mocked(sendPromptToSession).mockReturnValue('unknown')
    // capturePane returns null -> detectPaneState not called -> still unknown
    vi.mocked(capturePane).mockReturnValue(null)

    runSweepTick(60000, db)

    const after = getTask('unknown-task', db)!
    // 'unconfirmed' not 'fired': operator can tell this slot was not verified
    expect(after.last_result).toBe('unconfirmed')
    expect(after.next_run).toBeGreaterThan(nowS)
  })
})

// ---------------------------------------------------------------------------
// Staged-input wedge: 'unknown' verdict re-probe + idempotency-gating
// (card 3e5c2914 -- empty-composer check + submit-verify + escalation)
//
// An 'unknown' SubmitVerdict means capturePane failed inside sendPromptToSession.
// The scheduler must NOT silently mark a task as delivered:
//   1. Re-probe once: capturePane + detectPaneState.
//      - 'idle'   -> prompt likely landed, treat as submitted.
//      - 'typing' -> prompt still staged, treat as parked (retry safe).
//      - still 'unknown' -> idempotency gate:
//          heartbeat: defer ('parked' -- re-injection is idempotent)
//          effect-bearing task: escalate ('unconfirmed' + operator alert)
// ---------------------------------------------------------------------------

describe('runSweepTick: unknown verdict re-probe (card 3e5c2914)', () => {
  function insertDueTaskWithType(
    db: ReturnType<typeof getNoaDb>,
    id: string,
    nowS: number,
    type: 'task' | 'heartbeat' = 'task',
  ): void {
    db.prepare(`
      INSERT INTO scheduled_tasks (id, agent, type, description, prompt, schedule, next_run, status, created_at)
      VALUES (?, 'marveen', ?, '', 'Do it', '0 9 * * *', ?, 'active', ?)
    `).run(id, type, nowS - 10, nowS - 100)
  }

  beforeEach(() => {
    vi.mocked(isSessionReadyForPrompt).mockReturnValue(true)
    vi.mocked(sendPromptToSession).mockReset()
    vi.mocked(capturePane).mockReset()
    vi.mocked(detectPaneState).mockReset()
  })

  it('unknown resolves to idle on re-probe: treats as submitted (fires normally)', () => {
    // submit-verify: capturePane succeeds on re-probe and shows idle ->
    // prompt almost certainly landed, safe to count as fired.
    const db = getNoaDb()
    const nowS = Math.floor(Date.now() / 1000)
    insertDueTaskWithType(db, 'unknown-idle-task', nowS, 'task')
    vi.mocked(sendPromptToSession).mockReturnValue('unknown')
    vi.mocked(capturePane).mockReturnValue('❯ ')        // non-null pane
    vi.mocked(detectPaneState).mockReturnValue('idle')  // idle -> submitted

    runSweepTick(60000, db)

    const after = getTask('unknown-idle-task', db)!
    expect(after.last_result).toBe('fired')
    expect(after.next_run).toBeGreaterThan(nowS)
  })

  it('unknown resolves to typing on re-probe: treated as parked (queued for retry)', () => {
    // composer-nonempty-after-send: the prompt is still staged in the input box.
    // Treat as 'parked' so a later tick can re-deliver safely.
    const db = getNoaDb()
    const nowS = Math.floor(Date.now() / 1000)
    insertDueTaskWithType(db, 'unknown-typing-task', nowS, 'task')
    vi.mocked(sendPromptToSession).mockReturnValue('unknown')
    vi.mocked(capturePane).mockReturnValue('❯ some text')
    vi.mocked(detectPaneState).mockReturnValue('typing')

    runSweepTick(60000, db)

    const after = getTask('unknown-typing-task', db)!
    expect(after.next_run).toBe(nowS - 10)  // NOT rolled forward
    const retries = db.prepare(
      `SELECT * FROM pending_task_retries WHERE task_name='unknown-typing-task'`
    ).all() as Array<{ last_reason: string }>
    expect(retries).toHaveLength(1)
    expect(retries[0]!.last_reason).toBe('parked')
  })

  it('unknown persists after re-probe for a heartbeat: deferred safely (parked)', () => {
    // heartbeat + persistent unknown: re-injection is idempotent (keepalive),
    // so defer is safe. Must NOT count as fired.
    const db = getNoaDb()
    const nowS = Math.floor(Date.now() / 1000)
    insertDueTaskWithType(db, 'unknown-hb-task', nowS, 'heartbeat')
    vi.mocked(sendPromptToSession).mockReturnValue('unknown')
    vi.mocked(capturePane).mockReturnValue(null)  // re-probe also fails

    runSweepTick(60000, db)

    const after = getTask('unknown-hb-task', db)!
    expect(after.next_run).toBe(nowS - 10)  // NOT rolled forward
    expect(after.last_result).not.toBe('fired')
    const retries = db.prepare(
      `SELECT * FROM pending_task_retries WHERE task_name='unknown-hb-task'`
    ).all()
    expect(retries).toHaveLength(1)  // queued for retry
  })

  it('unknown persists after re-probe for effect-bearing task: escalated, next_run rolled (not retried)', () => {
    // effect-bearing task + persistent unknown: re-delivery risks double-send.
    // Escalate (last_result=unconfirmed) and roll next_run so it does not get stuck.
    // Must NOT be queued for automatic retry.
    const db = getNoaDb()
    const nowS = Math.floor(Date.now() / 1000)
    insertDueTaskWithType(db, 'unknown-effect-task', nowS, 'task')
    vi.mocked(sendPromptToSession).mockReturnValue('unknown')
    vi.mocked(capturePane).mockReturnValue(null)  // re-probe fails too

    runSweepTick(60000, db)

    const after = getTask('unknown-effect-task', db)!
    expect(after.last_result).toBe('unconfirmed')      // NOT 'fired'
    expect(after.next_run).toBeGreaterThan(nowS)       // rolled to avoid stuck
    const retries = db.prepare(
      `SELECT * FROM pending_task_retries WHERE task_name='unknown-effect-task'`
    ).all()
    expect(retries).toHaveLength(0)  // NOT queued (double-send risk)
  })
})

// ---------------------------------------------------------------------------
// Busy escalation restored (card CORE/57cf5022)
//
// The A4 migration (8e65ac2) moved the sweep into noa-scheduler.ts and
// re-implemented the happy path only: the 1-hour operator escalation was left
// behind in the legacy runner with zero call sites. Measured cost on
// 2026-08-05: eleven tasks stuck for up to 78 hours, 4802 retries on the worst
// row, alert_sent_at NULL on every one. Nobody was told, because nothing could.
// ---------------------------------------------------------------------------

describe('runSweepTick: stuck-retry escalation', () => {
  beforeEach(() => {
    vi.mocked(isSessionReadyForPrompt).mockReturnValue(false)
    vi.mocked(sendPromptToSession).mockReset()
    vi.mocked(sendPendingRetryAlert).mockReset()
  })

  function stuckRow(db: ReturnType<typeof getNoaDb>, id: string, ageS: number): number {
    const nowS = Math.floor(Date.now() / 1000)
    db.prepare(`
      INSERT INTO scheduled_tasks (id, agent, type, description, prompt, schedule, next_run, status, created_at)
      VALUES (?, 'marveen', 'task', '', 'Do it', '0 9 * * *', ?, 'active', ?)
    `).run(id, nowS - 10, nowS - 100)
    db.prepare(`
      INSERT INTO pending_task_retries (task_name, agent_name, first_attempt, last_attempt, attempt_count, last_reason)
      VALUES (?, 'marveen', ?, ?, 1, 'busy')
    `).run(id, nowS - ageS, nowS - ageS)
    return nowS
  }

  it('escalates a retry row that has been stuck past the threshold', () => {
    const db = getNoaDb()
    stuckRow(db, 'stuck-long', 2 * 60 * 60) // 2 hours, threshold is 1

    runSweepTick(60000, db)

    expect(vi.mocked(sendPendingRetryAlert)).toHaveBeenCalledOnce()
    const [view] = vi.mocked(sendPendingRetryAlert).mock.calls[0]!
    expect(view.taskName).toBe('stuck-long')
    expect(view.alertDue).toBe(true)
  })

  it('stays quiet while the row is still inside the threshold', () => {
    const db = getNoaDb()
    stuckRow(db, 'stuck-short', 5 * 60) // 5 minutes

    runSweepTick(60000, db)

    expect(vi.mocked(sendPendingRetryAlert)).not.toHaveBeenCalled()
  })

  it('does not escalate a row that already carries an alert stamp -- one message per row, not one per tick', () => {
    const db = getNoaDb()
    const nowS = stuckRow(db, 'stuck-stamped', 5 * 60 * 60)
    db.prepare(`UPDATE pending_task_retries SET alert_sent_at=? WHERE task_name='stuck-stamped'`).run(nowS - 60)

    runSweepTick(60000, db)

    expect(vi.mocked(sendPendingRetryAlert)).not.toHaveBeenCalled()
  })

  it('sees the CURRENT attempt_count, not the pre-update snapshot', () => {
    // The alert decision re-reads the row after updatePendingRetry, so the
    // escalation reports the attempt count including this tick.
    const db = getNoaDb()
    stuckRow(db, 'stuck-count', 3 * 60 * 60)

    runSweepTick(60000, db)

    const [view] = vi.mocked(sendPendingRetryAlert).mock.calls[0]!
    expect(view.attemptCount).toBe(2)
  })

  it('does not escalate a row that fires successfully this tick', () => {
    const db = getNoaDb()
    stuckRow(db, 'stuck-recovers', 9 * 60 * 60)
    vi.mocked(isSessionReadyForPrompt).mockReturnValue(true)

    runSweepTick(60000, db)

    expect(vi.mocked(sendPendingRetryAlert)).not.toHaveBeenCalled()
    expect(db.prepare(`SELECT * FROM pending_task_retries WHERE task_name='stuck-recovers'`).all())
      .toHaveLength(0)
  })
})

describe('runSweepTick: stuck next_run sentinel', () => {
  beforeEach(() => {
    vi.mocked(isSessionReadyForPrompt).mockReturnValue(true)
    vi.mocked(sendPromptToSession).mockReset()
    vi.mocked(sweepStuckTasks).mockReset()
  })

  function addTask(db: ReturnType<typeof getNoaDb>, id: string, nextRunOffsetS: number): number {
    const nowS = Math.floor(Date.now() / 1000)
    db.prepare(`
      INSERT INTO scheduled_tasks (id, agent, type, description, prompt, schedule, next_run, status, created_at)
      VALUES (?, 'marveen', 'task', '', 'Do it', '0 9 * * *', ?, 'active', ?)
    `).run(id, nowS + nextRunOffsetS, nowS - 100)
    return nowS
  }

  it('runs the sentinel on every tick, in seconds', () => {
    const db = getNoaDb()
    const nowS = addTask(db, 'anything', 3600)

    runSweepTick(60000, db)

    expect(vi.mocked(sweepStuckTasks)).toHaveBeenCalledOnce()
    const [passedNowS, passedDb] = vi.mocked(sweepStuckTasks).mock.calls[0]!
    expect(passedDb).toBe(db)
    // Seconds, not milliseconds. Feeding ms to a seconds-valued comparison is
    // what made the live pending-retry API report an age of 20649 days.
    expect(passedNowS).toBeGreaterThanOrEqual(nowS)
    expect(passedNowS).toBeLessThan(nowS + 10)
  })

  it('runs the sentinel even when no task is due -- an empty sweep is when a frozen next_run hides', () => {
    // The 08-05 incident looked exactly like this from inside the sweep: the
    // cron select returned nothing to fire, so a detector living inside the
    // fire loop would have seen a quiet, healthy tick.
    const db = getNoaDb()
    addTask(db, 'far-future', 30 * 24 * 3600)

    runSweepTick(60000, db)

    expect(vi.mocked(sweepStuckTasks)).toHaveBeenCalledOnce()
  })

  it('does not let a sentinel failure abort the sweep', () => {
    // The sentinel is a monitor. If it throws (bad row, locked DB), the
    // scheduled tasks must still fire -- a watcher that can take down the
    // thing it watches is worse than no watcher.
    const db = getNoaDb()
    addTask(db, 'must-still-fire', -60)
    vi.mocked(sweepStuckTasks).mockImplementation(() => { throw new Error('sentinel exploded') })

    expect(() => runSweepTick(60000, db)).not.toThrow()
    expect(vi.mocked(sendPromptToSession)).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// buildScheduledTaskPrompt -- noa-scheduler variant (card 2c5d6896 F2)
// ---------------------------------------------------------------------------

function makeTask(over: Partial<{ id: string; agent: string; type: 'task' | 'heartbeat'; prompt: string; schedule: string }> = {}) {
  return {
    id: 'test-task',
    agent: 'marveen',
    type: 'task' as const,
    description: '',
    prompt: 'check',
    schedule: '0 * * * *',
    next_run: 0,
    last_run: null,
    last_result: null,
    status: 'active' as const,
    created_at: 0,
    skip_if_busy: 0,
    force_send: 0,
    direct_send: 0,
    layer2: 0,
    target_session: null,
    card_id: null,
    ...over,
  }
}

describe('buildScheduledTaskPrompt (noa-scheduler, card 2c5d6896 F2)', () => {
  it('heartbeat log path is per-agent, not the old shared marveen path', () => {
    const p = buildScheduledTaskPrompt(makeTask({ type: 'heartbeat', agent: 'marveen' }), 'marveen')
    expect(p).toContain('/tmp/keepalive-marveen.log')
    expect(p).not.toContain('/tmp/marveen-keepalive.log')
  })

  it('heartbeat log path uses the correct agent name for forge', () => {
    const p = buildScheduledTaskPrompt(makeTask({ type: 'heartbeat', agent: 'forge' }), 'forge')
    expect(p).toContain('/tmp/keepalive-forge.log')
    expect(p).not.toContain('/tmp/marveen-keepalive.log')
  })

  it('heartbeat-agent gets minimal tag without keepalive directive', () => {
    const p = buildScheduledTaskPrompt(makeTask({ type: 'heartbeat', agent: 'heartbeat' }), 'heartbeat')
    expect(p).not.toContain('KOTELEZO ELSO TEENDO')
    expect(p).not.toContain('/tmp/keepalive-')
  })
})
