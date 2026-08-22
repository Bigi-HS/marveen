import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'node:stream'

// Mock noa-memory before importing the route.
vi.mock('../noa-memory.js', () => ({
  getDailyLogDates: vi.fn(),
  recallByDateRange: vi.fn(),
  recallSearch: vi.fn(),
}))

import {
  getDailyLogDates,
  recallByDateRange,
  recallSearch,
} from '../noa-memory.js'
import { tryHandleRecall } from '../web/routes/recall.js'

function call(method: string, fullPath: string) {
  const url = new URL('http://x' + fullPath)
  const req = Readable.from([]) as any
  const captured: { status: number; body: any } = { status: 200, body: undefined }
  const res = {
    writeHead(s: number) { captured.status = s; return res },
    end(b?: string) { captured.body = b ? JSON.parse(b) : undefined },
  } as any
  return tryHandleRecall({ req, res, method, path: url.pathname, url } as any)
    .then(handled => ({ handled, ...captured }))
}

const EMPTY_RESULT = {
  logs: [],
  memories: [],
  dateRange: { from: '', to: '' },
}

beforeEach(() => { vi.clearAllMocks() })

describe('GET /api/recall -- query-only (recallSearch path)', () => {
  it('calls recallSearch from noa-memory when q is set and no date', async () => {
    (recallSearch as ReturnType<typeof vi.fn>).mockReturnValue(EMPTY_RESULT)
    const r = await call('GET', '/api/recall?q=test')
    expect(r.handled).toBe(true)
    expect(recallSearch).toHaveBeenCalledWith('test', undefined, 50)
    expect(recallByDateRange).not.toHaveBeenCalled()
  })

  it('passes agent and limit params to recallSearch', async () => {
    (recallSearch as ReturnType<typeof vi.fn>).mockReturnValue(EMPTY_RESULT)
    await call('GET', '/api/recall?q=hello&agent=kidd&limit=20')
    expect(recallSearch).toHaveBeenCalledWith('hello', 'kidd', 20)
  })

  it('caps limit at 200', async () => {
    (recallSearch as ReturnType<typeof vi.fn>).mockReturnValue(EMPTY_RESULT)
    await call('GET', '/api/recall?q=x&limit=9999')
    expect(recallSearch).toHaveBeenCalledWith('x', undefined, 200)
  })
})

describe('GET /api/recall -- date range path', () => {
  it('calls recallByDateRange from noa-memory with parsed date', async () => {
    (recallByDateRange as ReturnType<typeof vi.fn>).mockReturnValue({
      ...EMPTY_RESULT,
      dateRange: { from: '2026-06-25', to: '2026-06-25' },
    })
    const r = await call('GET', '/api/recall?date=2026-06-25')
    expect(r.handled).toBe(true)
    expect(recallByDateRange).toHaveBeenCalledWith('2026-06-25', '2026-06-25', undefined)
  })

  it('passes agent param to recallByDateRange', async () => {
    (recallByDateRange as ReturnType<typeof vi.fn>).mockReturnValue(EMPTY_RESULT)
    await call('GET', '/api/recall?date=2026-06-25&agent=dave')
    expect(recallByDateRange).toHaveBeenCalledWith('2026-06-25', '2026-06-25', 'dave')
  })

  it('returns 400 on unparseable date expression', async () => {
    const r = await call('GET', '/api/recall?date=gibberish12345678')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(400)
    expect(recallByDateRange).not.toHaveBeenCalled()
  })

  it('formatRecallResult adds created_label and drops embedding', async () => {
    (recallByDateRange as ReturnType<typeof vi.fn>).mockReturnValue({
      logs: [{ id: 1, agent_id: 'kidd', date: '2026-06-25', content: 'x', created_at: 1_000_000 }],
      memories: [{ id: 10, agent_id: 'kidd', content: 'y', category: 'warm', keywords: null,
        created_at: 1_000_000, updated_at: 1_000_000, tier: 'warm', embedding: new Float32Array([1, 2]) }],
      dateRange: { from: '2026-06-25', to: '2026-06-25' },
    })
    const r = await call('GET', '/api/recall?date=2026-06-25')
    expect(r.body.logs[0]).toHaveProperty('created_label')
    expect(r.body.memories[0]).toHaveProperty('created_label')
    expect(r.body.memories[0]).not.toHaveProperty('embedding')
    expect(r.body.summary.logCount).toBe(1)
    expect(r.body.summary.memoryCount).toBe(1)
  })
})

describe('GET /api/recall/dates', () => {
  it('calls getDailyLogDates from noa-memory', async () => {
    (getDailyLogDates as ReturnType<typeof vi.fn>).mockReturnValue(['2026-06-25', '2026-06-24'])
    const r = await call('GET', '/api/recall/dates?agent=kidd&limit=30')
    expect(r.handled).toBe(true)
    expect(getDailyLogDates).toHaveBeenCalledWith('kidd', 30)
    expect(r.body).toEqual(['2026-06-25', '2026-06-24'])
  })

  it('uses MAIN_AGENT_ID and default limit when params absent', async () => {
    (getDailyLogDates as ReturnType<typeof vi.fn>).mockReturnValue([])
    const r = await call('GET', '/api/recall/dates')
    expect(r.handled).toBe(true)
    expect(getDailyLogDates).toHaveBeenCalledWith(expect.any(String), 90)
  })
})
