import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { Readable } from 'node:stream'
import { rmSync } from 'node:fs'
import { initDatabase, getRecentToolCalls } from '../db.js'
import { tryHandleToolLog } from '../web/routes/tool-log.js'
import { subscribeDashboardEvents, type DashboardEvent } from '../event-bus.js'

// Card 229a9000 (agent-flow event-relay steal): the dormant /api/tool-log
// ingestion endpoint (fed by an opt-in PostToolUse hook) is lifted into a LIVE
// relay -- a successful POST now emits a thin-notify 'hook-event' onto the
// in-process bus so the dashboard streams tool activity in real time
// (agent-flow's zero-latency streaming, adapted to our SSE thin-notify bus).
// The emit is metadata-only (session + tool name), never the input payload.

const TEST_DB = '/tmp/test-tool-log-relay.db'

async function call(method: string, fullPath: string, body?: unknown, remoteAddress?: string) {
  const url = new URL('http://x' + fullPath)
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  const req = Object.assign(stream, remoteAddress !== undefined ? { socket: { remoteAddress } } : {}) as any
  const captured: { status: number; body: any } = { status: 0, body: undefined }
  const res = {
    writeHead(status: number) { captured.status = status; return res },
    end(b?: string) { captured.body = b ? JSON.parse(b) : undefined },
  } as any
  const handled = await tryHandleToolLog({ req, res, method, path: url.pathname, url } as any)
  return { handled, ...captured }
}

/** Collect bus events emitted while `fn` runs. */
async function captureEvents(fn: () => Promise<void>): Promise<DashboardEvent[]> {
  const seen: DashboardEvent[] = []
  const off = subscribeDashboardEvents((e) => seen.push(e))
  try { await fn() } finally { off() }
  return seen
}

describe('tool-log relay -> dashboard event bus (card 229a9000)', () => {
  beforeEach(() => { rmSync(TEST_DB, { force: true }); initDatabase(TEST_DB) })
  afterAll(() => rmSync(TEST_DB, { force: true }))

  it('emits a thin-notify hook-event on a successful POST', async () => {
    const events = await captureEvents(async () => {
      const r = await call('POST', '/api/tool-log', {
        session_id: 'sess-1', tool_name: 'Bash', input_summary: 'ls -la', success: true,
      })
      expect(r.status).toBe(200)
      expect(r.body.ok).toBe(true)
    })
    const hook = events.filter((e) => e.type === 'hook-event')
    expect(hook).toHaveLength(1)
    expect(hook[0].id).toBe('sess-1')
    expect(hook[0].action).toBe('Bash')
    // still persisted
    expect(getRecentToolCalls(3600).map((r) => r.tool_name)).toContain('Bash')
  })

  it('carries success=false through as a distinct action suffix', async () => {
    const events = await captureEvents(async () => {
      await call('POST', '/api/tool-log', { session_id: 's2', tool_name: 'Edit', success: false })
    })
    const hook = events.find((e) => e.type === 'hook-event')
    expect(hook).toBeTruthy()
    expect(hook!.action).toBe('Edit:failed')
  })

  it('does NOT emit when validation fails (missing tool_name -> 400)', async () => {
    const events = await captureEvents(async () => {
      const r = await call('POST', '/api/tool-log', { session_id: 'sX' })
      expect(r.status).toBe(400)
    })
    expect(events.some((e) => e.type === 'hook-event')).toBe(false)
  })

  it('does NOT emit on a GET read', async () => {
    const events = await captureEvents(async () => {
      const r = await call('GET', '/api/tool-log?since=3600')
      expect(r.status === 0 || r.status === 200).toBe(true)
    })
    expect(events.some((e) => e.type === 'hook-event')).toBe(false)
  })
})

// Card 8293dd11: tool-log-relay loopback-guard
describe('tool-log POST loopback guard (card 8293dd11)', () => {
  beforeEach(() => { rmSync(TEST_DB, { force: true }); initDatabase(TEST_DB) })
  afterAll(() => rmSync(TEST_DB, { force: true }))

  it('rejects POST from a non-loopback address with 403', async () => {
    const r = await call('POST', '/api/tool-log',
      { session_id: 's-evil', tool_name: 'Bash', success: true }, '1.2.3.4')
    expect(r.status).toBe(403)
  })

  it('allows POST from 127.0.0.1', async () => {
    const r = await call('POST', '/api/tool-log',
      { session_id: 's-lb1', tool_name: 'Bash', success: true }, '127.0.0.1')
    expect(r.status).toBe(200)
  })

  it('allows POST from localhost', async () => {
    const r = await call('POST', '/api/tool-log',
      { session_id: 's-lb2', tool_name: 'Bash', success: true }, 'localhost')
    expect(r.status).toBe(200)
  })

  it('allows POST from ::1', async () => {
    const r = await call('POST', '/api/tool-log',
      { session_id: 's-lb3', tool_name: 'Bash', success: true }, '::1')
    expect(r.status).toBe(200)
  })

  it('allows POST from ::ffff:127.0.0.1 (IPv4-mapped on dual-stack listener)', async () => {
    const r = await call('POST', '/api/tool-log',
      { session_id: 's-lb4', tool_name: 'Bash', success: true }, '::ffff:127.0.0.1')
    expect(r.status).toBe(200)
  })

  it('allows POST when remoteAddress is absent (Unix socket / in-process)', async () => {
    const r = await call('POST', '/api/tool-log',
      { session_id: 's-unix', tool_name: 'Bash', success: true })
    expect(r.status).toBe(200)
  })
})
