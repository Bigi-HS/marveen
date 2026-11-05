// GET /api/schedules: ?agent= filter must narrow results to that agent,
// and every returned task must include an `id` field (= task.name) so callers
// (e.g. Dr. Stone's prune script, card b4e5f898) can DELETE /api/schedules/:id
// without an extra name-lookup step. Card a77bf9d5.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'node:stream'

const { mockListScheduledTasks } = vi.hoisted(() => ({
  mockListScheduledTasks: vi.fn(),
}))

const TASKS = [
  { name: 'vitamin-weekly',    agent: 'marveen', schedule: '0 9 * * 1', enabled: true,  createdAt: 1000, type: 'heartbeat' as const },
  { name: 'weight-daily',      agent: 'marveen', schedule: '0 8 * * *', enabled: true,  createdAt: 900,  type: 'heartbeat' as const },
  { name: 'scout-news-daily',  agent: 'scout',   schedule: '0 7 * * *', enabled: true,  createdAt: 800,  type: 'task' as const },
  { name: 'dave-code-review',  agent: 'dave',    schedule: '0 10 * * *', enabled: false, createdAt: 700, type: 'task' as const },
]

vi.mock('../web/scheduled-tasks-io.js', () => ({
  SCHEDULED_TASKS_DIR: '/tmp/fake-tasks-filter',
  MAX_SCHEDULED_TASK_PROMPT_LEN: 50_000,
  listScheduledTasks: mockListScheduledTasks,
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
vi.mock('../noa-scheduler.js', () => ({
  recordTriggerFire: vi.fn(),
  getTask: vi.fn(),
  syncTaskToNoa: vi.fn(),
  removeTaskFromNoa: vi.fn(),
  updateTask: vi.fn(),
  TaskNotFoundError: class TaskNotFoundError extends Error { name = 'TaskNotFoundError' },
}))
vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'marveen',
  BOT_NAME: 'NoA',
  PROJECT_ROOT: '/tmp/test-claudeclaw',
}))
vi.mock('../web/agent-config.js', () => ({
  listAgentNames: () => ['scout', 'dave'],
  readAgentDisplayName: (n: string) => n,
  readFileOr: (_p: string, fallback: string) => fallback,
}))

import { tryHandleSchedules } from '../web/routes/schedules.js'

function makeGetCtx(url: string) {
  const req = Readable.from([]) as any
  let _body: any
  const res = {
    writeHead() { return res },
    end(b?: string) { _body = b ? JSON.parse(b) : undefined },
  } as any
  const parsed = new URL(url)
  return {
    ctx: {
      req, res,
      method: 'GET',
      path: parsed.pathname,
      url: parsed,
      identity: { agentId: 'marveen', scopes: ['admin:*'], source: 'operator' },
    } as any,
    body: () => _body as Array<Record<string, unknown>>,
  }
}

beforeEach(() => {
  mockListScheduledTasks.mockReturnValue([...TASKS])
})

describe('GET /api/schedules -- id field present (card a77bf9d5)', () => {
  it('every task in the response has an id field equal to task.name', async () => {
    const { ctx, body } = makeGetCtx('http://x/api/schedules')
    await tryHandleSchedules(ctx)
    const tasks = body()
    expect(tasks.length).toBeGreaterThan(0)
    for (const task of tasks) {
      expect(task.id).toBeDefined()
      expect(task.id).toBe(task.name)
    }
  })

  it('id field is present even for disabled tasks', async () => {
    const { ctx, body } = makeGetCtx('http://x/api/schedules')
    await tryHandleSchedules(ctx)
    const disabled = body().find(t => t.name === 'dave-code-review')
    expect(disabled).toBeDefined()
    expect(disabled!.id).toBe('dave-code-review')
  })
})

describe('GET /api/schedules -- ?agent= filter (card a77bf9d5)', () => {
  it('no ?agent= param returns all tasks', async () => {
    const { ctx, body } = makeGetCtx('http://x/api/schedules')
    await tryHandleSchedules(ctx)
    expect(body().length).toBe(4)
  })

  it('?agent=marveen returns only marveen tasks', async () => {
    const { ctx, body } = makeGetCtx('http://x/api/schedules?agent=marveen')
    await tryHandleSchedules(ctx)
    const tasks = body()
    expect(tasks.length).toBe(2)
    expect(tasks.every(t => t.agent === 'marveen')).toBe(true)
  })

  it('?agent=scout returns only scout tasks', async () => {
    const { ctx, body } = makeGetCtx('http://x/api/schedules?agent=scout')
    await tryHandleSchedules(ctx)
    const tasks = body()
    expect(tasks.length).toBe(1)
    expect(tasks[0].name).toBe('scout-news-daily')
    expect(tasks[0].id).toBe('scout-news-daily')
  })

  it('?agent= with no match returns empty array', async () => {
    const { ctx, body } = makeGetCtx('http://x/api/schedules?agent=nonexistent')
    await tryHandleSchedules(ctx)
    expect(body()).toEqual([])
  })

  it('?agent= filter is exact (not substring match)', async () => {
    // 'ma' must not match 'marveen'
    const { ctx, body } = makeGetCtx('http://x/api/schedules?agent=ma')
    await tryHandleSchedules(ctx)
    expect(body()).toEqual([])
  })

  it('filtered tasks still include id field', async () => {
    const { ctx, body } = makeGetCtx('http://x/api/schedules?agent=scout')
    await tryHandleSchedules(ctx)
    expect(body()[0].id).toBe('scout-news-daily')
  })
})
