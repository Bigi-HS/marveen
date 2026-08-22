import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { getDb, initDatabase } from '../db.js'
import { tryHandleTokenUsage } from '../web/routes/token-usage.js'

// Fable safety-net F1 slice-4: configurable daily ceiling + restrict signal.
// Fable's absolute Max-plan quota is opaque, so the ceiling is an operator-set
// absolute daily TOKEN budget (default disabled -> no spurious trips). The
// fail-safe principle holds regardless of the ceiling: restrict = exceeded OR
// blind, so blind telemetry always restricts (card d1ca8650 design doc).

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const TOKEN_USAGE_DDL = `
  CREATE TABLE IF NOT EXISTS token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL, session_id TEXT NOT NULL, timestamp INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    content_preview TEXT, tool_name TEXT, task_title TEXT, project TEXT, model TEXT, spawned_by TEXT
  )
`
const NOW_MS = 1_784_000_000_000
const nowSec = Math.floor(NOW_MS / 1000)

// A row "today" (1 min ago -> inside the Budapest calendar-day window). Defaults
// to the fixed NOW_MS clock the unit tests inject; the route tests pass the real
// wall-clock second because the endpoint reads Date.now() (no nowMs injection).
function insertTodayFable(totalTokens: number, atSec: number = nowSec - 60): void {
  getDb().prepare(`
    INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, model)
    VALUES ('percy', 'sess-c', ?, ?, 0, 'claude-fable-5')
  `).run(atSec, totalTokens)
}
const realNowSec = (): number => Math.floor(Date.now() / 1000) - 60

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  getDb().exec(TOKEN_USAGE_DDL)
})
beforeEach(() => { getDb().exec('DELETE FROM token_usage') })

describe('getFableBudgetStatus', () => {
  it('never trips when the ceiling is disabled (null), regardless of spend', async () => {
    const { getFableBudgetStatus } = await import('../web/token-usage.js')
    insertTodayFable(1_000_000)
    const s = getFableBudgetStatus({ nowMs: NOW_MS, agentsOnFable: [], dailyTokenCeiling: 0 })
    expect(s.ceiling.dailyTotalTokens).toBeNull()
    expect(s.warn).toBe(false)
    expect(s.exceeded).toBe(false)
    expect(s.restrict).toBe(false)
  })

  it('warn=false / exceeded=false when today is under the warn band', async () => {
    const { getFableBudgetStatus } = await import('../web/token-usage.js')
    insertTodayFable(500) // < 80% of 1000
    const s = getFableBudgetStatus({ nowMs: NOW_MS, agentsOnFable: [], dailyTokenCeiling: 1000 })
    expect(s.warn).toBe(false)
    expect(s.exceeded).toBe(false)
    expect(s.restrict).toBe(false)
    expect(s.ceiling.dailyTotalTokens).toBe(1000)
  })

  it('warn=true / exceeded=false in the 80-99% band', async () => {
    const { getFableBudgetStatus } = await import('../web/token-usage.js')
    insertTodayFable(850) // >= 80% of 1000, < 100%
    const s = getFableBudgetStatus({ nowMs: NOW_MS, agentsOnFable: [], dailyTokenCeiling: 1000 })
    expect(s.warn).toBe(true)
    expect(s.exceeded).toBe(false)
    expect(s.restrict).toBe(false)
  })

  it('exceeded=true / restrict=true at or over 100% of the ceiling', async () => {
    const { getFableBudgetStatus } = await import('../web/token-usage.js')
    insertTodayFable(1200)
    const s = getFableBudgetStatus({ nowMs: NOW_MS, agentsOnFable: [], dailyTokenCeiling: 1000 })
    expect(s.warn).toBe(true)
    expect(s.exceeded).toBe(true)
    expect(s.restrict).toBe(true)
  })

  it('restrict=true from blind alone, even with no ceiling and zero spend (fail-safe)', async () => {
    const { getFableBudgetStatus } = await import('../web/token-usage.js')
    const s = getFableBudgetStatus({ nowMs: NOW_MS, agentsOnFable: ['percy'], dailyTokenCeiling: 0 })
    expect(s.blind).toBe(true)
    expect(s.exceeded).toBe(false)
    expect(s.restrict).toBe(true)
  })

  it('honours a custom warnRatio', async () => {
    const { getFableBudgetStatus } = await import('../web/token-usage.js')
    insertTodayFable(600) // 60% of 1000
    const strict = getFableBudgetStatus({ nowMs: NOW_MS, agentsOnFable: [], dailyTokenCeiling: 1000, warnRatio: 0.5 })
    expect(strict.warn).toBe(true)
    const lenient = getFableBudgetStatus({ nowMs: NOW_MS, agentsOnFable: [], dailyTokenCeiling: 1000, warnRatio: 0.9 })
    expect(lenient.warn).toBe(false)
  })
})

async function call(method: string, path: string) {
  const url = new URL('http://x' + path)
  const req = Object.assign(Readable.from([]), { url: path }) as never
  const captured: { status: number; body: any } = { status: 200, body: undefined }
  const res = {
    writeHead(status: number) { captured.status = status; return res },
    end(b?: string) { captured.body = b ? JSON.parse(b) : undefined },
  } as never
  const handled = await tryHandleTokenUsage({ req, res, method, path: url.pathname, url } as never)
  return { handled, ...captured }
}

describe('GET /api/token-usage/fable-budget/status (route wiring)', () => {
  it('does not handle POST', async () => {
    const r = await call('POST', '/api/token-usage/fable-budget/status')
    expect(r.handled).toBe(false)
  })

  it('returns 200 + status shape when not restricting', async () => {
    const r = await call('GET', '/api/token-usage/fable-budget/status?ceiling=100000')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body).toHaveProperty('restrict', false)
    expect(r.body).toHaveProperty('exceeded')
    expect(r.body).toHaveProperty('ceiling')
    expect(r.body.ceiling.dailyTotalTokens).toBe(100000)
  })

  it('returns 503 when today exceeds the ?ceiling= override (restrict)', async () => {
    insertTodayFable(1200, realNowSec()) // endpoint uses real Date.now() for the today window
    const r = await call('GET', '/api/token-usage/fable-budget/status?ceiling=1000')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(503)
    expect(r.body.exceeded).toBe(true)
    expect(r.body.restrict).toBe(true)
  })
})
