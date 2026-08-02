// GET /api/schedules/agents must label each agent with its Boss-facing DISPLAY
// name, not the raw routing id (card b79a5d3a display-name sweep). This endpoint
// feeds the agent selector the Boss sees in the schedule UI, so "scout" must
// render as "Dr. Stone".

import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'

// Heavy / fs-and-DB-touching deps of routes/schedules.ts, mocked so the module
// graph loads without tmux, the DB, or the real filesystem.
vi.mock('../web/scheduled-tasks-io.js', () => ({
  SCHEDULED_TASKS_DIR: '/tmp/fake-tasks-agents',
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

// The unit under test: listAgentNames returns routing ids; readAgentDisplayName
// resolves each to its Boss-facing display name.
vi.mock('../web/agent-config.js', () => ({
  listAgentNames: () => ['scout', 'dave'],
  readAgentDisplayName: (n: string) =>
    ({ scout: 'Dr. Stone', dave: 'Dave' } as Record<string, string>)[n] ?? n,
  readFileOr: (_p: string, fallback: string) => fallback,
}))

import { tryHandleSchedules } from '../web/routes/schedules.js'

function makeCtx() {
  const req = Readable.from([]) as any
  let _body: any
  const res = {
    writeHead() { return res },
    end(b?: string) { _body = b ? JSON.parse(b) : undefined },
  } as any
  return {
    ctx: {
      req, res,
      method: 'GET',
      path: '/api/schedules/agents',
      url: new URL('http://x/api/schedules/agents'),
    } as any,
    body: () => _body,
  }
}

describe('GET /api/schedules/agents -- Boss-facing display labels (b79a5d3a)', () => {
  it('labels each agent with its display name, not the routing id', async () => {
    const { ctx, body } = makeCtx()
    const handled = await tryHandleSchedules(ctx)
    expect(handled).toBe(true)
    const agents = body() as Array<{ name: string; label: string }>
    // main agent: id marveen -> BOT_NAME label
    expect(agents[0]).toMatchObject({ name: 'marveen', label: 'NoA' })
    // routing name stays the id (technical key), label is the display name
    const scout = agents.find(a => a.name === 'scout')
    expect(scout?.label).toBe('Dr. Stone')
    const dave = agents.find(a => a.name === 'dave')
    expect(dave?.label).toBe('Dave')
    // no raw stale id leaks into a label
    expect(agents.every(a => a.label !== 'scout')).toBe(true)
  })
})
