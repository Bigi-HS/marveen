import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'node:stream'

// Mock noa-memory before importing the route so the route picks up the mock.
vi.mock('../noa-memory.js', () => ({
  appendDailyLog: vi.fn(),
  getDailyLog: vi.fn(),
  getDailyLogDates: vi.fn(),
  recallByDateRange: vi.fn(),
}))

import {
  appendDailyLog,
  getDailyLogDates,
  recallByDateRange,
} from '../noa-memory.js'
import { tryHandleDailyLog } from '../web/routes/daily-log.js'

function call(method: string, fullPath: string, body?: unknown) {
  const url = new URL('http://x' + fullPath)
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
  ) as any
  const captured: { status: number; body: any } = { status: 200, body: undefined }
  const res = {
    writeHead(s: number) { captured.status = s; return res },
    end(b?: string) { captured.body = b ? JSON.parse(b) : undefined },
  } as any
  return tryHandleDailyLog({ req, res, method, path: url.pathname, url } as any)
    .then(handled => ({ handled, ...captured }))
}

beforeEach(() => { vi.clearAllMocks() })

describe('POST /api/daily-log', () => {
  it('calls appendDailyLog from noa-memory (not db.ts)', async () => {
    const r = await call('POST', '/api/daily-log', { agent_id: 'kidd', content: 'test entry' })
    expect(r.handled).toBe(true)
    expect(appendDailyLog).toHaveBeenCalledWith('kidd', 'test entry')
    expect(r.body).toEqual({ ok: true })
  })

  it('uses MAIN_AGENT_ID when agent_id is omitted', async () => {
    const r = await call('POST', '/api/daily-log', { content: 'no agent' })
    expect(r.handled).toBe(true)
    expect(appendDailyLog).toHaveBeenCalledWith(expect.any(String), 'no agent')
  })

  it('returns 400 when content is empty', async () => {
    const r = await call('POST', '/api/daily-log', { content: '  ' })
    expect(r.handled).toBe(true)
    expect(r.status).toBe(400)
    expect(appendDailyLog).not.toHaveBeenCalled()
  })

  it('returns 400 when content is missing', async () => {
    const r = await call('POST', '/api/daily-log', { agent_id: 'kidd' })
    expect(r.handled).toBe(true)
    expect(r.status).toBe(400)
  })
})

describe('GET /api/daily-log', () => {
  it('calls recallByDateRange with the same date twice and returns log entries', async () => {
    const fakeLogs = [
      { id: 1, agent_id: 'kidd', date: '2026-06-25', content: 'log line', created_at: 1000 },
    ]
    ;(recallByDateRange as ReturnType<typeof vi.fn>).mockReturnValue({
      logs: fakeLogs,
      memories: [],
      dateRange: { from: '2026-06-25', to: '2026-06-25' },
    })
    const r = await call('GET', '/api/daily-log?agent=kidd&date=2026-06-25')
    expect(r.handled).toBe(true)
    expect(recallByDateRange).toHaveBeenCalledWith('2026-06-25', '2026-06-25', 'kidd')
    // Response shape must match legacy: array of { id, content, created_at }
    expect(r.body).toEqual([{ id: 1, content: 'log line', created_at: 1000 }])
  })

  it('strips agent_id and date from the returned log entries (response shape parity)', async () => {
    ;(recallByDateRange as ReturnType<typeof vi.fn>).mockReturnValue({
      logs: [{ id: 2, agent_id: 'dave', date: '2026-06-25', content: 'x', created_at: 999 }],
      memories: [],
      dateRange: { from: '2026-06-25', to: '2026-06-25' },
    })
    const r = await call('GET', '/api/daily-log?agent=dave&date=2026-06-25')
    expect(r.body[0]).not.toHaveProperty('agent_id')
    expect(r.body[0]).not.toHaveProperty('date')
    expect(r.body[0]).toHaveProperty('id')
    expect(r.body[0]).toHaveProperty('content')
    expect(r.body[0]).toHaveProperty('created_at')
  })
})

describe('GET /api/daily-log/dates', () => {
  it('calls getDailyLogDates from noa-memory and returns the result', async () => {
    ;(getDailyLogDates as ReturnType<typeof vi.fn>).mockReturnValue(['2026-06-25', '2026-06-24'])
    const r = await call('GET', '/api/daily-log/dates?agent=kidd')
    expect(r.handled).toBe(true)
    expect(getDailyLogDates).toHaveBeenCalledWith('kidd')
    expect(r.body).toEqual(['2026-06-25', '2026-06-24'])
  })
})

describe('route does not handle unrelated paths', () => {
  it('returns false for unknown paths', async () => {
    const r = await call('GET', '/api/other')
    expect(r.handled).toBe(false)
  })
})
