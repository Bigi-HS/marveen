// PUT / DELETE / toggle on /api/schedules/:name must NOT 404 when the task has
// no on-disk file-dir but DOES live in noa.db (card 5010afbd). The routes were
// existsSync(dir)-gated, so a scheduled_task that exists only as a noa.db row
// (e.g. its file-dir was hand-deleted but the row survived active -- the
// power-sleep-watchdog EXIT:2 case) could not be paused/edited/deleted and every
// call 404'd. The fix falls back to the noa.db row (getTask -> updateTask /
// removeTaskFromNoa) when the dir is absent, and only genuinely 404s when the
// task is in neither place (or soft-deleted).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable } from 'node:stream'

// SCHEDULED_TASKS_DIR points at a dir that does NOT exist on disk, so
// existsSync(join(DIR, name)) is false for every name -> every call exercises
// the noa.db-only fallback branch. (Literal inlined: the vi.mock factory is
// hoisted above top-level consts.)
vi.mock('../web/scheduled-tasks-io.js', () => ({
  SCHEDULED_TASKS_DIR: '/tmp/noa-sched-fallback-nonexistent-xyz',
  MAX_SCHEDULED_TASK_PROMPT_LEN: 50_000,
  listScheduledTasks: vi.fn().mockReturnValue([]),
  writeScheduledTask: vi.fn(),
}))
vi.mock('../web/schedule-runner.js', () => ({
  buildScheduledTaskPrompt: vi.fn(),
  scheduledDbPath: vi.fn(),
}))
vi.mock('../../db.js', () => ({
  listPendingTaskRetries: vi.fn().mockReturnValue([]),
  deletePendingTaskRetryById: vi.fn(),
}))
vi.mock('../agent.js', () => ({ runAgent: vi.fn() }))
vi.mock('../web/cron.js', () => ({
  // Route-level isolation: a 5-field digit/*/,- expression is "valid", anything
  // with other chars (e.g. "not a cron") is rejected -> 400.
  isValidCronShape: (s: string) => /^[\d*/,\-\s]+$/.test(s) && s.trim().split(/\s+/).length === 5,
}))
vi.mock('../noa-scheduler.js', () => ({
  recordTriggerFire: vi.fn(),
  getTask: vi.fn(),
  syncTaskToNoa: vi.fn(),
  removeTaskFromNoa: vi.fn(),
  updateTask: vi.fn(),
  getNoaDb: vi.fn(),
  TaskNotFoundError: class TaskNotFoundError extends Error { name = 'TaskNotFoundError' },
}))
vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'marveen',
  BOT_NAME: 'NoA',
  PROJECT_ROOT: '/tmp/test-claudeclaw',
}))
vi.mock('../web/agent-config.js', () => ({
  listAgentNames: () => [],
  readAgentDisplayName: (n: string) => n,
  readFileOr: (_p: string, fallback: string) => fallback,
}))

import { tryHandleSchedules } from '../web/routes/schedules.js'
import { getTask, updateTask, removeTaskFromNoa, syncTaskToNoa } from '../noa-scheduler.js'
import { writeScheduledTask } from '../web/scheduled-tasks-io.js'

type Captured = { status: number; body: any }

function run(method: string, path: string, bodyObj?: unknown): Promise<Captured & { handled: boolean }> {
  const payload = bodyObj === undefined ? [] : [Buffer.from(JSON.stringify(bodyObj))]
  const req = Readable.from(payload) as any
  const cap: Captured = { status: 200, body: undefined }
  const res = {
    writeHead(code: number) { cap.status = code; return res },
    end(b?: string) { cap.body = b ? JSON.parse(b) : undefined },
  } as any
  const ctx = { req, res, method, path, url: new URL('http://x' + path) } as any
  return tryHandleSchedules(ctx).then(handled => ({ handled, ...cap }))
}

function dbTask(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'db-only', agent: 'marveen', type: 'task', description: '', prompt: 'p',
    schedule: '0 9 * * *', next_run: 1, last_run: null, last_result: null,
    status: 'active', created_at: 1, skip_if_busy: 0, force_send: 0,
    direct_send: 0, layer2: 0, target_session: null, card_id: null, ...over,
  } as any
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PUT /api/schedules/:name -- noa.db-only fallback (card 5010afbd)', () => {
  it('updates the noa.db row (no 404, no file write) when the dir is absent but the row exists', async () => {
    vi.mocked(getTask).mockReturnValue(dbTask())
    const r = await run('PUT', '/api/schedules/db-only', { enabled: false, description: 'x' })
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    expect(vi.mocked(updateTask)).toHaveBeenCalledWith(
      'db-only', expect.objectContaining({ status: 'paused', description: 'x' })
    )
    expect(vi.mocked(writeScheduledTask)).not.toHaveBeenCalled()
  })

  it('404s when the task is in neither the dir nor noa.db', async () => {
    vi.mocked(getTask).mockReturnValue(null)
    const r = await run('PUT', '/api/schedules/ghost', { enabled: false })
    expect(r.status).toBe(404)
    expect(vi.mocked(updateTask)).not.toHaveBeenCalled()
  })

  it('404s for a soft-deleted noa.db row', async () => {
    vi.mocked(getTask).mockReturnValue(dbTask({ status: 'deleted' }))
    const r = await run('PUT', '/api/schedules/db-only', { enabled: true })
    expect(r.status).toBe(404)
    expect(vi.mocked(updateTask)).not.toHaveBeenCalled()
  })

  it('still rejects an invalid cron before touching noa.db', async () => {
    vi.mocked(getTask).mockReturnValue(dbTask())
    const r = await run('PUT', '/api/schedules/db-only', { schedule: 'not a cron' })
    expect(r.status).toBe(400)
    expect(vi.mocked(updateTask)).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/schedules/:name -- noa.db-only fallback (card 5010afbd)', () => {
  it('soft-deletes the noa.db row (no 404) when the dir is absent but the row exists', async () => {
    vi.mocked(getTask).mockReturnValue(dbTask())
    const r = await run('DELETE', '/api/schedules/db-only')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    expect(vi.mocked(removeTaskFromNoa)).toHaveBeenCalledWith('db-only')
  })

  it('404s when the task is in neither the dir nor noa.db', async () => {
    vi.mocked(getTask).mockReturnValue(null)
    const r = await run('DELETE', '/api/schedules/ghost')
    expect(r.status).toBe(404)
    expect(vi.mocked(removeTaskFromNoa)).not.toHaveBeenCalled()
  })

  it('404s for a soft-deleted noa.db row', async () => {
    vi.mocked(getTask).mockReturnValue(dbTask({ status: 'deleted' }))
    const r = await run('DELETE', '/api/schedules/db-only')
    expect(r.status).toBe(404)
    expect(vi.mocked(removeTaskFromNoa)).not.toHaveBeenCalled()
  })
})

describe('POST /api/schedules/:name/toggle -- noa.db-only fallback (card 5010afbd)', () => {
  it('pauses an active noa.db row when the dir is absent', async () => {
    vi.mocked(getTask).mockReturnValue(dbTask({ status: 'active' }))
    const r = await run('POST', '/api/schedules/db-only/toggle')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, enabled: false })
    expect(vi.mocked(updateTask)).toHaveBeenCalledWith('db-only', { status: 'paused' })
  })

  it('resumes a paused noa.db row when the dir is absent', async () => {
    vi.mocked(getTask).mockReturnValue(dbTask({ status: 'paused' }))
    const r = await run('POST', '/api/schedules/db-only/toggle')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, enabled: true })
    expect(vi.mocked(updateTask)).toHaveBeenCalledWith('db-only', { status: 'active' })
  })

  it('404s when the task is in neither the dir nor noa.db', async () => {
    vi.mocked(getTask).mockReturnValue(null)
    const r = await run('POST', '/api/schedules/ghost/toggle')
    expect(r.status).toBe(404)
    expect(vi.mocked(updateTask)).not.toHaveBeenCalled()
  })
})
