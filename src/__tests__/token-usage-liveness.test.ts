import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { getDb, initDatabase } from '../db.js'
import { tryHandleTokenUsage } from '../web/routes/token-usage.js'

// Fable safety-net F1 slice-2: liveness / stale-flag on token_usage.
// The collector that feeds token_usage has silently stalled before (~5h gap,
// card d1ca8650); a safety-net that reads a blind telemetry stream must fail
// CONSERVATIVELY -> "no fresh data" reports stale=true, never a false all-clear.

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

// Isolated in-memory DB so MAX(timestamp) is fully controlled by the test and
// never contaminated by live prod rows (getTokenUsageLiveness scans the whole
// table, so a shared DB would make the age non-deterministic).
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

// A fixed "now" so every age assertion is deterministic. Epoch ms.
const NOW_MS = 1_784_000_000_000
const MINUTE_MS = 60 * 1000
// Mirrors TOKEN_USAGE_DEFAULT_STALE_MS in the module under test (20 minutes).
const TOKEN_USAGE_DEFAULT_STALE_MS_EXPECTED = 20 * 60 * 1000

function insertRow(tsSeconds: number, model = 'claude-opus-4-8'): void {
  getDb().prepare(`
    INSERT INTO token_usage
      (agent, session_id, timestamp, input_tokens, output_tokens,
       cache_read_tokens, cache_creation_tokens, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('test-agent', 'sess-live', tsSeconds, 100, 20, 0, 0, model)
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  getDb().exec(TOKEN_USAGE_DDL)
})

beforeEach(() => {
  getDb().exec('DELETE FROM token_usage')
})

describe('getTokenUsageLiveness', () => {
  it('reports stale=true with null age when the table is empty (fail-safe: blind = conservative)', async () => {
    const { getTokenUsageLiveness } = await import('../web/token-usage.js')
    const r = getTokenUsageLiveness({ nowMs: NOW_MS })
    expect(r.rowsSeen).toBe(false)
    expect(r.lastTimestamp).toBeNull()
    expect(r.ageMs).toBeNull()
    expect(r.stale).toBe(true)
  })

  it('reports stale=false for a fresh row (within the 20-minute default window)', async () => {
    const { getTokenUsageLiveness } = await import('../web/token-usage.js')
    insertRow(Math.floor((NOW_MS - 5 * MINUTE_MS) / 1000)) // 5 min old
    const r = getTokenUsageLiveness({ nowMs: NOW_MS })
    expect(r.rowsSeen).toBe(true)
    expect(r.stale).toBe(false)
    expect(r.ageMs).toBeGreaterThanOrEqual(5 * MINUTE_MS - 1000)
    expect(r.ageMs).toBeLessThanOrEqual(5 * MINUTE_MS + 1000)
  })

  it('reports stale=true for a row older than the 20-minute default window', async () => {
    const { getTokenUsageLiveness } = await import('../web/token-usage.js')
    insertRow(Math.floor((NOW_MS - 30 * MINUTE_MS) / 1000)) // 30 min old
    const r = getTokenUsageLiveness({ nowMs: NOW_MS })
    expect(r.stale).toBe(true)
    expect(r.ageMs).toBeGreaterThan(20 * MINUTE_MS)
  })

  it('uses MAX(timestamp): a fresh row among old rows keeps it not-stale', async () => {
    const { getTokenUsageLiveness } = await import('../web/token-usage.js')
    insertRow(Math.floor((NOW_MS - 90 * MINUTE_MS) / 1000)) // stale blip
    insertRow(Math.floor((NOW_MS - 60 * MINUTE_MS) / 1000)) // stale blip
    insertRow(Math.floor((NOW_MS - 2 * MINUTE_MS) / 1000))  // fresh
    const r = getTokenUsageLiveness({ nowMs: NOW_MS })
    expect(r.stale).toBe(false)
    expect(r.ageMs).toBeLessThan(3 * MINUTE_MS)
  })

  it('is exclusive at the threshold boundary (age == threshold is NOT stale, just over IS)', async () => {
    const { getTokenUsageLiveness } = await import('../web/token-usage.js')
    const threshold = 10 * MINUTE_MS
    insertRow(Math.floor((NOW_MS - 10 * MINUTE_MS) / 1000)) // exactly at threshold
    const atBoundary = getTokenUsageLiveness({ nowMs: NOW_MS, staleThresholdMs: threshold })
    expect(atBoundary.stale).toBe(false)

    getDb().exec('DELETE FROM token_usage')
    insertRow(Math.floor((NOW_MS - 10 * MINUTE_MS - 2000) / 1000)) // just over
    const justOver = getTokenUsageLiveness({ nowMs: NOW_MS, staleThresholdMs: threshold })
    expect(justOver.stale).toBe(true)
  })

  it('honours a custom staleThresholdMs and echoes it back', async () => {
    const { getTokenUsageLiveness } = await import('../web/token-usage.js')
    insertRow(Math.floor((NOW_MS - 45 * MINUTE_MS) / 1000)) // 45 min old
    const lenient = getTokenUsageLiveness({ nowMs: NOW_MS, staleThresholdMs: 60 * MINUTE_MS })
    expect(lenient.stale).toBe(false)
    expect(lenient.staleThresholdMs).toBe(60 * MINUTE_MS)

    const strict = getTokenUsageLiveness({ nowMs: NOW_MS, staleThresholdMs: 30 * MINUTE_MS })
    expect(strict.stale).toBe(true)
    expect(strict.staleThresholdMs).toBe(30 * MINUTE_MS)
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

describe('GET /api/token-usage/liveness (route wiring)', () => {
  it('does not handle a non-matching path', async () => {
    const r = await call('GET', '/api/token-usage/other')
    expect(r.handled).toBe(false)
  })

  it('does not handle POST on the liveness path', async () => {
    const r = await call('POST', '/api/token-usage/liveness')
    expect(r.handled).toBe(false)
  })

  it('returns the liveness shape with the 20-min default threshold (empty table -> stale)', async () => {
    const r = await call('GET', '/api/token-usage/liveness')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body.staleThresholdMs).toBe(TOKEN_USAGE_DEFAULT_STALE_MS_EXPECTED)
    expect(r.body.rowsSeen).toBe(false)
    expect(r.body.stale).toBe(true)
    expect(r.body.lastTimestamp).toBeNull()
  })

  it('honours the ?stale_ms= override in the response', async () => {
    const r = await call('GET', '/api/token-usage/liveness?stale_ms=99999')
    expect(r.handled).toBe(true)
    expect(r.body.staleThresholdMs).toBe(99999)
  })

  it('ignores a non-positive / garbage ?stale_ms= and falls back to the default', async () => {
    const bad = await call('GET', '/api/token-usage/liveness?stale_ms=-5')
    expect(bad.body.staleThresholdMs).toBe(TOKEN_USAGE_DEFAULT_STALE_MS_EXPECTED)
    const garbage = await call('GET', '/api/token-usage/liveness?stale_ms=abc')
    expect(garbage.body.staleThresholdMs).toBe(TOKEN_USAGE_DEFAULT_STALE_MS_EXPECTED)
  })
})
