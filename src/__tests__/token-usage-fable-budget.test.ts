import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { getDb, initDatabase } from '../db.js'
import { tryHandleTokenUsage } from '../web/routes/token-usage.js'
import { isFableModel, FABLE_MODEL_TAGS } from '../fable-config.js'

// Fable safety-net F1 slice-3: /api/token-usage/fable-budget.
// Fable runs on the Max-plan quota (not per-token billing), so the actionable
// budget currency is TOKENS / requests, not USD (fable is unpriced in the model
// registry -> costUsd is best-effort 0). The endpoint aggregates fable-only rows
// over 5h / today / week windows with a direct DB window-query (never the
// limit-capped detail endpoint, which would silently truncate history), and
// carries the fail-safe blind flag when an agent is on fable but no fable rows
// are visible (card d1ca8650).

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
    agent TEXT NOT NULL,
    session_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    content_preview TEXT,
    tool_name TEXT,
    task_title TEXT,
    project TEXT,
    model TEXT,
    spawned_by TEXT
  )
`

const NOW_MS = 1_784_000_000_000
const HOUR = 3600
const DAY = 86400

function insertRow(agent: string, tsSeconds: number, model: string, input = 100, output = 20): void {
  getDb().prepare(`
    INSERT INTO token_usage
      (agent, session_id, timestamp, input_tokens, output_tokens,
       cache_read_tokens, cache_creation_tokens, model)
    VALUES (?, ?, ?, ?, ?, 0, 0, ?)
  `).run(agent, 'sess-fb', tsSeconds, input, output, model)
}

const nowSec = Math.floor(NOW_MS / 1000)

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  getDb().exec(TOKEN_USAGE_DDL)
})
beforeEach(() => {
  getDb().exec('DELETE FROM token_usage')
})

describe('isFableModel', () => {
  it('matches the canonical tag exactly and by dated-variant prefix', () => {
    expect(isFableModel('claude-fable-5')).toBe(true)
    expect(isFableModel('claude-fable-5-20260901')).toBe(true)
  })
  it('rejects non-fable models and nullish input', () => {
    expect(isFableModel('claude-opus-4-8')).toBe(false)
    expect(isFableModel(null)).toBe(false)
    expect(isFableModel(undefined)).toBe(false)
    expect(isFableModel('')).toBe(false)
  })
})

describe('getFableBudget', () => {
  it('returns all-zero windows and blind=false on an empty table with nobody on fable', async () => {
    const { getFableBudget } = await import('../web/token-usage.js')
    const b = getFableBudget({ nowMs: NOW_MS, agentsOnFable: [] })
    expect(b.fableRowsSeenTotal).toBe(0)
    expect(b.fiveHour.rows).toBe(0)
    expect(b.today.rows).toBe(0)
    expect(b.week.rows).toBe(0)
    expect(b.fiveHour.totalTokens).toBe(0)
    expect(b.blind).toBe(false)
    expect(b.tags).toEqual([...FABLE_MODEL_TAGS])
  })

  it('counts only fable rows, excluding non-fable models in the same window', async () => {
    const { getFableBudget } = await import('../web/token-usage.js')
    insertRow('percy', nowSec - HOUR, 'claude-fable-5', 1000, 200)
    insertRow('dave', nowSec - HOUR, 'claude-opus-4-8', 9999, 9999) // must be ignored
    const b = getFableBudget({ nowMs: NOW_MS, agentsOnFable: [] })
    expect(b.fiveHour.rows).toBe(1)
    expect(b.fiveHour.inputTokens).toBe(1000)
    expect(b.fiveHour.outputTokens).toBe(200)
    expect(b.fiveHour.totalTokens).toBe(1200)
  })

  it('respects window boundaries: 5h vs week vs 8-days-old', async () => {
    const { getFableBudget } = await import('../web/token-usage.js')
    insertRow('percy', nowSec - 2 * HOUR, 'claude-fable-5', 100, 10) // in 5h + week
    insertRow('percy', nowSec - 6 * HOUR, 'claude-fable-5', 100, 10) // NOT 5h, in week
    insertRow('percy', nowSec - 8 * DAY, 'claude-fable-5', 100, 10)  // in none of the windows
    const b = getFableBudget({ nowMs: NOW_MS, agentsOnFable: [] })
    expect(b.fiveHour.rows).toBe(1)
    expect(b.week.rows).toBe(2)
    expect(b.fableRowsSeenTotal).toBe(3) // all-time count ignores the windows
  })

  it('computes a tokens/hour burn-rate over the 5h window', async () => {
    const { getFableBudget } = await import('../web/token-usage.js')
    // 5000 total tokens across the 5h window -> 1000 tokens/hour
    insertRow('percy', nowSec - HOUR, 'claude-fable-5', 4000, 1000)
    const b = getFableBudget({ nowMs: NOW_MS, agentsOnFable: [] })
    expect(b.fiveHour.totalTokens).toBe(5000)
    expect(b.fiveHour.windowHours).toBeCloseTo(5, 5)
    expect(b.fiveHour.burnRateTokensPerHour).toBeCloseTo(1000, 5)
    expect(b.fiveHour.costUsd).toBeGreaterThanOrEqual(0) // fable unpriced -> 0, never negative
  })

  it('flags blind=true when an agent is on fable but zero fable rows are visible', async () => {
    const { getFableBudget } = await import('../web/token-usage.js')
    const b = getFableBudget({ nowMs: NOW_MS, agentsOnFable: ['percy'] })
    expect(b.week.rows).toBe(0)
    expect(b.blind).toBe(true)
    expect(b.agentsOnFable).toEqual(['percy'])
  })

  it('clears blind=false once fable rows appear in the week window', async () => {
    const { getFableBudget } = await import('../web/token-usage.js')
    insertRow('percy', nowSec - 2 * DAY, 'claude-fable-5', 100, 10)
    const b = getFableBudget({ nowMs: NOW_MS, agentsOnFable: ['percy'] })
    expect(b.blind).toBe(false)
  })

  it('today window starts at Budapest local midnight', async () => {
    const { getFableBudget } = await import('../web/token-usage.js')
    const b = getFableBudget({ nowMs: NOW_MS, agentsOnFable: [] })
    // the window is same-day: at most 24h wide and never in the future
    expect(b.today.to).toBe(nowSec)
    expect(b.today.from).toBeLessThanOrEqual(nowSec)
    expect(nowSec - b.today.from).toBeLessThan(DAY)
    // that boundary is 00:00:00 wall-clock in Europe/Budapest
    const wall = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Budapest', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date(b.today.from * 1000))
    expect(wall).toBe('00:00:00')
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

describe('GET /api/token-usage/fable-budget (route wiring)', () => {
  it('does not handle POST on the path', async () => {
    const r = await call('POST', '/api/token-usage/fable-budget')
    expect(r.handled).toBe(false)
  })
  it('returns 200 with the fable-budget shape', async () => {
    const r = await call('GET', '/api/token-usage/fable-budget')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body).toHaveProperty('fiveHour')
    expect(r.body).toHaveProperty('today')
    expect(r.body).toHaveProperty('week')
    expect(r.body).toHaveProperty('blind')
    expect(r.body).toHaveProperty('fableRowsSeenTotal')
    expect(r.body.tags).toEqual([...FABLE_MODEL_TAGS])
  })
})
