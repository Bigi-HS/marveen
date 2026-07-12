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
})
