import { describe, it, expect, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { tryHandleNotify, __setBotTokenReader } from '../web/routes/notify.js'

// Drives the route handler with a fake req/res (same pattern as gate-route.test.ts).
// Covers only the network-free branches: path/method guard, JSON parse, field
// validation, and the token-missing 500. The actual Telegram fetch (502/network)
// is exercised by the live smoke, not here.
async function call(method: string, path: string, rawBody?: string) {
  const url = new URL('http://x' + path)
  const req = Readable.from(rawBody === undefined ? [] : [Buffer.from(rawBody)]) as never
  const captured: { status: number; body: any } = { status: 200, body: undefined }
  const res = {
    writeHead(status: number) {
      captured.status = status
      return res
    },
    end(b?: string) {
      captured.body = b ? JSON.parse(b) : undefined
    },
  } as never
  const handled = await tryHandleNotify({ req, res, method, path: url.pathname, url } as never)
  return { handled, ...captured }
}

afterEach(() => __setBotTokenReader(null))

describe('POST /api/notify/telegram (route guard + validation)', () => {
  it('does not handle a non-matching path', async () => {
    const r = await call('POST', '/api/other')
    expect(r.handled).toBe(false)
  })

  it('does not handle GET on the notify path', async () => {
    const r = await call('GET', '/api/notify/telegram')
    expect(r.handled).toBe(false)
  })

  it('rejects invalid JSON with 400', async () => {
    const r = await call('POST', '/api/notify/telegram', '{not json')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('invalid JSON')
  })

  it('rejects a missing chat_id with 400', async () => {
    const r = await call('POST', '/api/notify/telegram', JSON.stringify({ text: 'hi' }))
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/chat_id and text/)
  })

  it('rejects a missing text with 400', async () => {
    const r = await call('POST', '/api/notify/telegram', JSON.stringify({ chat_id: '123' }))
    expect(r.status).toBe(400)
  })

  it('rejects a blank (whitespace-only) text with 400', async () => {
    const r = await call('POST', '/api/notify/telegram', JSON.stringify({ chat_id: '123', text: '   ' }))
    expect(r.status).toBe(400)
  })

  it('returns 500 when the bot token is not configured', async () => {
    __setBotTokenReader(() => null)
    const r = await call('POST', '/api/notify/telegram', JSON.stringify({ chat_id: '123', text: 'hi' }))
    expect(r.status).toBe(500)
    expect(r.body.error).toMatch(/bot token/)
  })

  // Regression (card fa3f5012): callers (NoA relay / claudia) serialize chat_id as a
  // JSON NUMBER (8643929442). The route trimmed chat_id assuming a string, so
  // `chat_id.trim()` threw `chat_id?.trim is not a function` -> uncaught -> generic
  // 500, silently breaking the Boss-DM server-side fallback. A numeric chat_id must
  // be coerced, not crash.
  it('accepts a NUMERIC chat_id without crashing (reaches token check, not a TypeError)', async () => {
    __setBotTokenReader(() => null)
    const r = await call('POST', '/api/notify/telegram', JSON.stringify({ chat_id: 8643929442, text: 'hi' }))
    expect(r.handled).toBe(true)
    expect(r.status).toBe(500)
    expect(r.body.error).toMatch(/bot token/)
  })

  it('rejects a numeric chat_id with missing text as 400 (validation, not a crash)', async () => {
    const r = await call('POST', '/api/notify/telegram', JSON.stringify({ chat_id: 8643929442 }))
    expect(r.handled).toBe(true)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/chat_id and text/)
  })
})

// FIX-001 (820753e1): 409 pass-through -- per-agent bot-probe blind-spot.
// The route returned 502 for ALL non-200 Telegram responses. A 409 Conflict
// (bot already polling) was indistinguishable from a real upstream failure.
// Fix: return 409 verbatim when Telegram returns 409; all other errors -> 502.
import { vi } from 'vitest'

describe('POST /api/notify/telegram -- 409 pass-through (FIX-001)', () => {
  afterEach(() => __setBotTokenReader(null))

  it('returns 409 when Telegram API returns 409 (bot conflict not masked as 502)', async () => {
    __setBotTokenReader(() => 'test-token')
    // Stub fetch to return a 409 response
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: () => Promise.resolve(JSON.stringify({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' })),
    })
    const origFetch = globalThis.fetch
    globalThis.fetch = mockFetch as typeof fetch
    try {
      const r = await call('POST', '/api/notify/telegram', JSON.stringify({ chat_id: '123', text: 'hi' }))
      expect(r.status).toBe(409)
      expect(r.body.error).toMatch(/409/)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('returns 502 for non-409 Telegram errors (unchanged behaviour)', async () => {
    __setBotTokenReader(() => 'test-token')
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('Too Many Requests'),
    })
    const origFetch = globalThis.fetch
    globalThis.fetch = mockFetch as typeof fetch
    try {
      const r = await call('POST', '/api/notify/telegram', JSON.stringify({ chat_id: '123', text: 'hi' }))
      expect(r.status).toBe(502)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
