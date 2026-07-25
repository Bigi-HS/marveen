// Route-level lost-inject tests for POST /api/schedules/:name/run with mode:'trigger'.
//
// Safety property: recordTriggerFire MUST be called only on 'fired' (prompt injected).
// On 'offline' or 'busy' it MUST NOT be called -- the prompt was NOT delivered, and
// advancing last_run/next_run would suppress the native runner's retry with no execution.
//
// These tests are RED-PROOF: they fail on the pre-fix code (busy-advance present).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import {
  tryHandleSchedules,
  __setInjector,
  __resetInjector,
  __setRecordFireFn,
  __resetRecordFireFn,
} from '../web/routes/schedules.js'
import { listScheduledTasks } from '../web/scheduled-tasks-io.js'
import type { TriggerStatus } from '../web/action-trigger.js'

// ---------------------------------------------------------------------------
// Mock filesystem-dependent / DB-heavy modules
// ---------------------------------------------------------------------------

vi.mock('../web/scheduled-tasks-io.js', () => ({
  SCHEDULED_TASKS_DIR: '/tmp/fake-tasks-triggermode',
  MAX_SCHEDULED_TASK_PROMPT_LEN: 50_000,
  listScheduledTasks: vi.fn().mockReturnValue([
    {
      name: 'todo-freshness-check',
      agent: 'forge',
      type: 'heartbeat' as const,
      prompt: 'check todo freshness',
      schedule: '0 * * * *',
      enabled: true,
    },
  ]),
  writeScheduledTask: vi.fn(),
}))

vi.mock('../web/schedule-runner.js', () => ({
  buildScheduledTaskPrompt: vi.fn().mockReturnValue('[Heartbeat: todo-freshness-check] check todo'),
  scheduledDbPath: vi.fn(),
}))

vi.mock('../web/action-trigger.js', () => ({
  // Actual inject fn is overridden per-test via __setInjector; this mock satisfies
  // the module graph so it never touches tmux.
  injectToSession: vi.fn().mockReturnValue('fired' as TriggerStatus),
  resolveSession: vi.fn().mockReturnValue('forge'),
}))

vi.mock('../noa-scheduler.js', () => ({
  // Actual recordFire is overridden per-test via __setRecordFireFn.
  recordTriggerFire: vi.fn(),
  getTask: vi.fn().mockReturnValue({
    id: 'todo-freshness-check',
    agent: 'forge',
    type: 'heartbeat',
    prompt: 'check todo freshness',
    schedule: '0 * * * *',
    next_run: Math.floor(Date.now() / 1000) + 3600,
    last_run: null,
    status: 'active',
  }),
  syncTaskToNoa: vi.fn(),
  removeTaskFromNoa: vi.fn(),
  updateTask: vi.fn(),
  TaskNotFoundError: class TaskNotFoundError extends Error { name = 'TaskNotFoundError' },
}))

vi.mock('../../db.js', () => ({
  listPendingTaskRetries: vi.fn().mockReturnValue([]),
  deletePendingTaskRetryById: vi.fn(),
}))

vi.mock('../agent.js', () => ({ runAgent: vi.fn() }))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(body?: unknown): { req: any; res: any; status: () => number; responseBody: () => any } {
  const chunks = body !== undefined ? [Buffer.from(JSON.stringify(body))] : []
  const req = Readable.from(chunks) as any
  let _status = 200
  let _body: any
  const res = {
    writeHead(s: number) { _status = s; return res },
    end(b?: string) { _body = b ? JSON.parse(b) : undefined },
  } as any
  return { req, res, status: () => _status, responseBody: () => _body }
}

async function callRun(body?: unknown) {
  const { req, res, status, responseBody } = makeReq(body)
  const handled = await tryHandleSchedules({
    req, res,
    method: 'POST',
    path: '/api/schedules/todo-freshness-check/run',
    url: new URL('http://x/api/schedules/todo-freshness-check/run'),
  } as any)
  return { handled, status: status(), body: responseBody() }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/schedules/:name/run -- trigger-mode LOST-INJECT safety (card bc3ccf39)', () => {
  let recordCalls: Array<unknown[]> = []

  beforeEach(() => {
    recordCalls = []
    __setRecordFireFn((...args) => { recordCalls.push(args) })
  })

  afterEach(() => {
    __resetInjector()
    __resetRecordFireFn()
  })

  // --- offline: prompt not injected, advance must not happen ---

  it('offline: returns 503 and does NOT call recordTriggerFire in trigger mode', async () => {
    __setInjector(() => 'offline')
    const r = await callRun({ mode: 'trigger' })
    expect(r.status).toBe(503)
    expect(recordCalls).toHaveLength(0)
  })

  it('offline: returns 503 and does NOT call recordTriggerFire in manual mode', async () => {
    __setInjector(() => 'offline')
    const r = await callRun({ mode: 'manual' })
    expect(r.status).toBe(503)
    expect(recordCalls).toHaveLength(0)
  })

  // --- busy: prompt not injected, advance must not happen (pre-fix code FAILS here) ---

  it('busy: returns 409 and does NOT call recordTriggerFire in trigger mode (LOST-INJECT)', async () => {
    __setInjector(() => 'busy')
    const r = await callRun({ mode: 'trigger' })
    expect(r.status).toBe(409)
    // SAFETY PROPERTY: recordTriggerFire must NOT be called -- prompt was not injected;
    // advancing would suppress native retry silently.
    expect(recordCalls).toHaveLength(0)
  })

  it('busy: returns 409 and does NOT call recordTriggerFire in manual mode', async () => {
    __setInjector(() => 'busy')
    const r = await callRun()
    expect(r.status).toBe(409)
    expect(recordCalls).toHaveLength(0)
  })

  // --- fired: prompt injected, trigger mode MUST advance ---

  it('fired + trigger mode: returns 200 and calls recordTriggerFire exactly once', async () => {
    __setInjector(() => 'fired')
    const r = await callRun({ mode: 'trigger' })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(recordCalls).toHaveLength(1)
  })

  it('fired + manual mode: returns 200 and does NOT call recordTriggerFire', async () => {
    __setInjector(() => 'fired')
    const r = await callRun({ mode: 'manual' })
    expect(r.status).toBe(200)
    expect(recordCalls).toHaveLength(0)
  })

  it('fired + no body (default manual): returns 200 and does NOT call recordTriggerFire', async () => {
    __setInjector(() => 'fired')
    const r = await callRun()
    expect(r.status).toBe(200)
    expect(recordCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Busy-benign for skipIfBusy tasks (card 9ad7334e). A skipIfBusy:true task
// treats a busy target as an EXPECTED benign skip, not an error: the /run must
// return 200 status:'skipped' so status-keying consumers (dashboard last-run,
// the wf-noa-003r n8n workflow) never surface benign busy-contention as a Boss
// FAIL alert. Native-retry safety is unchanged -- recordTriggerFire is still NOT
// called (last_run/next_run not advanced), so the native runner retries.
// ---------------------------------------------------------------------------

describe('POST /api/schedules/:name/run -- busy is benign for skipIfBusy tasks (card 9ad7334e)', () => {
  let recordCalls: Array<unknown[]> = []

  beforeEach(() => {
    recordCalls = []
    __setRecordFireFn((...args) => { recordCalls.push(args) })
    // A skipIfBusy:true task (the todo-freshness-check shape) for this block only.
    vi.mocked(listScheduledTasks).mockReturnValue([
      {
        name: 'todo-freshness-check',
        agent: 'forge',
        type: 'heartbeat' as const,
        prompt: 'check todo freshness',
        schedule: '0 * * * *',
        enabled: true,
        skipIfBusy: true,
      },
    ] as any)
  })

  afterEach(() => {
    __resetInjector()
    __resetRecordFireFn()
    // Restore the default (skipIfBusy-less) task for the other suites.
    vi.mocked(listScheduledTasks).mockReturnValue([
      {
        name: 'todo-freshness-check',
        agent: 'forge',
        type: 'heartbeat' as const,
        prompt: 'check todo freshness',
        schedule: '0 * * * *',
        enabled: true,
      },
    ] as any)
  })

  it('busy + trigger mode: returns 200 status:skipped, deferred, and does NOT advance', async () => {
    __setInjector(() => 'busy')
    const r = await callRun({ mode: 'trigger' })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.status).toBe('skipped')
    expect(r.body.deferred).toBe(true)
    expect(r.body.reason).toBe('busy')
    // Native-retry safety preserved: no fire recorded.
    expect(recordCalls).toHaveLength(0)
  })

  it('busy + manual mode: returns 200 status:skipped (benign, no FAIL surface)', async () => {
    __setInjector(() => 'busy')
    const r = await callRun()
    expect(r.status).toBe(200)
    expect(r.body.status).toBe('skipped')
    expect(recordCalls).toHaveLength(0)
  })

  it('fired still wins for a skipIfBusy task (200 ok, trigger advances)', async () => {
    __setInjector(() => 'fired')
    const r = await callRun({ mode: 'trigger' })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(recordCalls).toHaveLength(1)
  })
})
