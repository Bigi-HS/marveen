// GET /api/agent-taskstate/:agent/replay -- S2 crash-gated startup replay.
//
// S1 shipped the shutdown marker (clean-vs-crash). S2 wires the /replay handler
// to classifyAndConsume() so a source=startup replay only fires after a CRASH
// last-boot, and CONSUMES the marker so the next boot's absence reads as crash.
//
// Axes covered here (HTTP-mock, mirrors kanban-put-unknown-field.test.ts):
//   (a) crash marker + fresh unconsumed non-empty record + source=startup -> non-null additionalContext
//   (b) clean marker + source=startup -> null (a normal boot must not resume)
//   (c) absent marker (== crash) + source=startup -> non-null
//   (d) the marker file is CONSUMED (deleted) after ONE /replay call
//
// A FRESH record + FRESH marker per case keeps the consume side-effect isolated.

import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { tryHandleAgentTaskState } from '../web/routes/agent-taskstate.js'
import { writeTaskState, clearTaskState } from '../web/agent-taskstate.js'
import { stampCleanShutdown } from '../web/shutdown-marker.js'
import type { RouteContext } from '../web/routes/types.js'
import type { IncomingMessage, ServerResponse } from 'node:http'

const AGENT = 'vitest-crashgate-agent'
const MARKER_PATH = join(PROJECT_ROOT, 'store', 'agent-checkpoints', `${AGENT}.shutdown`)

function cleanup(): void {
  clearTaskState(AGENT)
  try { if (existsSync(MARKER_PATH)) unlinkSync(MARKER_PATH) } catch { /* best effort */ }
}
afterEach(cleanup)

function makeReplayCtx(agent: string, source: string): { ctx: RouteContext; captured: { status: number; body: string } } {
  const captured = { status: 200, body: '' }
  const req = { method: 'GET', headers: {} } as unknown as IncomingMessage
  const res = {
    writeHead(status: number) { captured.status = status },
    end(data: string) { captured.body = data },
  } as unknown as ServerResponse
  const path = `/api/agent-taskstate/${agent}/replay`
  const url = new URL(`http://localhost${path}?source=${encodeURIComponent(source)}`)
  const ctx: RouteContext = { req, res, path, method: 'GET', url, identity: null as never }
  return { ctx, captured }
}

function armRecord(): void {
  writeTaskState(AGENT, { summary: 'building X', nextAction: 'open the PR', doneSteps: ['merged #276'] }, Date.now())
}

describe('GET /replay -- S2 crash-gated startup replay', () => {
  it('crash marker (absent) + fresh record + source=startup -> non-null additionalContext', async () => {
    armRecord()
    // no clean marker written -> classifyAndConsume reads absence as 'crash'
    const { ctx, captured } = makeReplayCtx(AGENT, 'startup')
    const handled = await tryHandleAgentTaskState(ctx)
    expect(handled).toBe(true)
    expect(captured.status).toBe(200)
    const parsed = JSON.parse(captured.body)
    expect(parsed.additionalContext).not.toBeNull()
    expect(parsed.additionalContext).toContain('open the PR')
  })

  it('clean marker + source=startup -> null (normal boot must not resume)', async () => {
    armRecord()
    stampCleanShutdown(AGENT, Date.now())
    const { ctx, captured } = makeReplayCtx(AGENT, 'startup')
    await tryHandleAgentTaskState(ctx)
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body).additionalContext).toBeNull()
  })

  it('consumes the marker after ONE /replay call (2nd call reads absence)', async () => {
    armRecord()
    stampCleanShutdown(AGENT, Date.now())
    expect(existsSync(MARKER_PATH)).toBe(true)
    const { ctx } = makeReplayCtx(AGENT, 'startup')
    await tryHandleAgentTaskState(ctx)
    // classifyAndConsume deleted the marker regardless of the verdict
    expect(existsSync(MARKER_PATH)).toBe(false)
  })

  it('compact source still replays regardless of a clean marker', async () => {
    armRecord()
    stampCleanShutdown(AGENT, Date.now())
    const { ctx, captured } = makeReplayCtx(AGENT, 'compact')
    await tryHandleAgentTaskState(ctx)
    expect(JSON.parse(captured.body).additionalContext).not.toBeNull()
  })
})
