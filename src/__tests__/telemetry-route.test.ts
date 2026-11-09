// P0 telemetry route handler tests (card 8b3b0408).
// Covers: POST /api/telemetry (single + batch + loopback guard),
//         GET  /api/telemetry/edges,
//         GET  /api/telemetry/series,
//         isolation: POST error returns 500 without crashing.

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { Readable } from 'node:stream'
import { rmSync } from 'node:fs'
import { initDatabase, getDb } from '../db.js'
import { tryHandleTelemetry } from '../web/routes/telemetry.js'
import { insertTelemetryEvent, rollupTelemetryDay } from '../web/telemetry.js'

const TEST_DB = '/tmp/test-telemetry-route.db'

function cleanDb() {
  for (const s of ['', '-wal', '-shm']) rmSync(TEST_DB + s, { force: true })
}

type CallResult = { handled: boolean; status: number; body: any }

async function call(
  method: string,
  fullPath: string,
  body?: unknown,
  remoteAddress = '127.0.0.1',
): Promise<CallResult> {
  const url = new URL('http://x' + fullPath)
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  ) as never
  ;(req as any).socket = { remoteAddress }
  const captured: CallResult = { handled: false, status: 200, body: undefined }
  const res = {
    writeHead(status: number) { captured.status = status; return res },
    end(b?: string) { captured.body = b ? JSON.parse(b) : undefined },
  } as never
  captured.handled = await tryHandleTelemetry({ req, res, method, path: url.pathname, url } as never)
  return captured
}

beforeEach(() => {
  cleanDb()
  initDatabase(TEST_DB)
})
afterAll(() => cleanDb())

// ---------------------------------------------------------------------------
// POST /api/telemetry
// ---------------------------------------------------------------------------

describe('POST /api/telemetry', () => {
  it('inserts a single event and returns 201', async () => {
    const r = await call('POST', '/api/telemetry', { actor: 'dave', verb: 'tool-call', object: 'Bash' })
    expect(r.handled).toBe(true)
    expect(r.status).toBe(201)
    expect(r.body.ok).toBe(true)
    expect(r.body.id).toBeGreaterThan(0)
  })

  it('inserts a batch array and returns inserted count', async () => {
    const r = await call('POST', '/api/telemetry', [
      { actor: 'dave', verb: 'tool-call', object: 'Bash' },
      { actor: 'thor', verb: 'tool-call', object: 'Read' },
    ])
    expect(r.status).toBe(201)
    expect(r.body.ok).toBe(true)
    expect(r.body.inserted).toBe(2)
  })

  it('returns 400 when actor/verb is missing', async () => {
    const r = await call('POST', '/api/telemetry', { verb: 'tool-call' })
    expect(r.status).toBe(400)
  })

  it('returns 400 for invalid JSON', async () => {
    const url = new URL('http://x/api/telemetry')
    const req = Readable.from([Buffer.from('not-json')]) as never
    ;(req as any).socket = { remoteAddress: '127.0.0.1' }
    const captured: CallResult = { handled: false, status: 200, body: undefined }
    const res = {
      writeHead(s: number) { captured.status = s; return res },
      end(b?: string) { captured.body = b ? JSON.parse(b) : undefined },
    } as never
    captured.handled = await tryHandleTelemetry({ req, res, method: 'POST', path: '/api/telemetry', url } as never)
    expect(captured.status).toBe(400)
  })

  it('rejects non-loopback POST with 403', async () => {
    const r = await call('POST', '/api/telemetry', { actor: 'x', verb: 'tool-call' }, '10.0.0.1')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(403)
  })

  it('returns false for unrelated paths', async () => {
    const r = await call('POST', '/api/other', { actor: 'x', verb: 'y' })
    expect(r.handled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// GET /api/telemetry/edges
// ---------------------------------------------------------------------------

describe('GET /api/telemetry/edges', () => {
  it('returns empty edges when no events', async () => {
    const r = await call('GET', '/api/telemetry/edges')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body.edges).toEqual([])
    expect(r.body.count).toBe(0)
  })

  it('returns aggregated edges after inserts', async () => {
    const now = Date.now()
    insertTelemetryEvent(getDb(), { actor: 'dave', verb: 'tool-call', object: 'Bash', ts: now })
    insertTelemetryEvent(getDb(), { actor: 'dave', verb: 'tool-call', object: 'Bash', ts: now })
    const r = await call('GET', `/api/telemetry/edges?from=${now - 1000}`)
    expect(r.body.count).toBe(1)
    expect(r.body.edges[0].weight_sum).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// GET /api/telemetry/series
// ---------------------------------------------------------------------------

describe('GET /api/telemetry/series', () => {
  const TEST_DAY = '2025-01-15'
  const TEST_TS  = 1736899200000 + 12 * 60 * 60 * 1000  // noon UTC 2025-01-15

  it('returns empty series when no daily data', async () => {
    const r = await call('GET', '/api/telemetry/series')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body.series).toEqual([])
    expect(r.body.count).toBe(0)
  })

  it('returns aggregated daily series after rollup', async () => {
    insertTelemetryEvent(getDb(), { actor: 'dave', verb: 'cost', cost_usd: 0.01, ts: TEST_TS })
    rollupTelemetryDay(getDb(), TEST_DAY)
    const r = await call('GET', `/api/telemetry/series?from=${TEST_DAY}&to=${TEST_DAY}`)
    expect(r.status).toBe(200)
    expect(r.body.count).toBe(1)
    expect(r.body.series[0].day).toBe(TEST_DAY)
    expect(r.body.series[0].cost_usd).toBeCloseTo(0.01, 5)
  })

  it('filters by metric=session-wake (only session-wake verb rows counted)', async () => {
    insertTelemetryEvent(getDb(), { actor: 'dave', verb: 'cost', cost_usd: 0.01, ts: TEST_TS })
    insertTelemetryEvent(getDb(), { actor: 'runner', verb: 'session-wake', ts: TEST_TS })
    rollupTelemetryDay(getDb(), TEST_DAY)
    const r = await call('GET', '/api/telemetry/series?metric=session-wake')
    expect(r.body.metric).toBe('session-wake')
    expect(r.body.count).toBe(1)
    expect(r.body.series[0].count).toBe(1)
  })

  it('echoes metric=all when no metric param given', async () => {
    const r = await call('GET', '/api/telemetry/series')
    expect(r.body.metric).toBe('all')
  })
})
