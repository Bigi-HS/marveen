// Tests for POST /api/push/subscribe and POST /api/push/send
// TDD: tests written before implementation (card 044a8f5f).
// Covers route guard, JSON validation, DB seam, and the VAPID-send seam.
// Live push delivery (actual web-push over the wire) is excluded -- network-free.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import {
  tryHandlePush,
  __setPushSender,
  __setDbSeam,
  type PushSubscription,
} from '../web/routes/push.js'

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

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
  const handled = await tryHandlePush({ req, res, method, path: url.pathname, url } as never)
  return { handled, ...captured }
}

// In-memory DB seam: stores subscriptions and provides lookup
function makeMemDb() {
  const subs = new Map<string, PushSubscription>()
  return {
    upsertSubscription(sub: PushSubscription) { subs.set(sub.endpoint, sub) },
    getSubscription(endpoint: string) { return subs.get(endpoint) ?? null },
    getAllSubscriptions() { return [...subs.values()] },
    deleteSubscription(endpoint: string) { subs.delete(endpoint) },
    _subs: subs,
  }
}

afterEach(() => {
  __setPushSender(null)
  __setDbSeam(null)
})

// ---------------------------------------------------------------------------
// Route guard: paths that are NOT /api/push/* must pass through
// ---------------------------------------------------------------------------

describe('route guard', () => {
  it('passes through unrelated paths', async () => {
    const r = await call('POST', '/api/kanban')
    expect(r.handled).toBe(false)
  })

  it('passes through GET on push subscribe', async () => {
    const r = await call('GET', '/api/push/subscribe')
    expect(r.handled).toBe(false)
  })

  it('passes through GET on push send', async () => {
    const r = await call('GET', '/api/push/send')
    expect(r.handled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// POST /api/push/subscribe
// ---------------------------------------------------------------------------

describe('POST /api/push/subscribe', () => {
  it('rejects invalid JSON with 400', async () => {
    const r = await call('POST', '/api/push/subscribe', '{bad json')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/invalid JSON/i)
  })

  it('rejects missing endpoint with 400', async () => {
    const body = JSON.stringify({ keys: { p256dh: 'abc', auth: 'xyz' } })
    const r = await call('POST', '/api/push/subscribe', body)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/endpoint/i)
  })

  it('rejects missing keys.p256dh with 400', async () => {
    const body = JSON.stringify({ endpoint: 'https://push.example.com/sub1', keys: { auth: 'xyz' } })
    const r = await call('POST', '/api/push/subscribe', body)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/p256dh/i)
  })

  it('rejects missing keys.auth with 400', async () => {
    const body = JSON.stringify({ endpoint: 'https://push.example.com/sub1', keys: { p256dh: 'abc' } })
    const r = await call('POST', '/api/push/subscribe', body)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/auth/i)
  })

  it('stores a valid subscription and returns 201', async () => {
    const db = makeMemDb()
    __setDbSeam(db)
    const body = JSON.stringify({
      endpoint: 'https://push.example.com/sub1',
      keys: { p256dh: 'BNFvtest1', auth: 'authtest1' },
    })
    const r = await call('POST', '/api/push/subscribe', body)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(201)
    expect(r.body.ok).toBe(true)
    expect(db._subs.has('https://push.example.com/sub1')).toBe(true)
  })

  it('upserts (re-register same endpoint returns 201 again)', async () => {
    const db = makeMemDb()
    __setDbSeam(db)
    const sub = { endpoint: 'https://push.example.com/sub1', keys: { p256dh: 'B1', auth: 'A1' } }
    await call('POST', '/api/push/subscribe', JSON.stringify(sub))
    const sub2 = { ...sub, keys: { p256dh: 'B2', auth: 'A2' } }
    const r = await call('POST', '/api/push/subscribe', JSON.stringify(sub2))
    expect(r.status).toBe(201)
    expect(db._subs.get('https://push.example.com/sub1')!.keys.p256dh).toBe('B2')
  })
})

// ---------------------------------------------------------------------------
// POST /api/push/send
// ---------------------------------------------------------------------------

describe('POST /api/push/send', () => {
  it('rejects invalid JSON with 400', async () => {
    const r = await call('POST', '/api/push/send', 'not json')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(400)
  })

  it('rejects missing title with 400', async () => {
    const r = await call('POST', '/api/push/send', JSON.stringify({ body: 'hi' }))
    expect(r.handled).toBe(true)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/title/i)
  })

  it('returns 200 with sent=0 when no subscriptions are registered', async () => {
    const db = makeMemDb()
    __setDbSeam(db)
    __setPushSender(vi.fn().mockResolvedValue(undefined))
    const r = await call('POST', '/api/push/send', JSON.stringify({ title: 'Hey', body: 'msg' }))
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body.sent).toBe(0)
  })

  it('calls the push sender for each subscription and returns sent count', async () => {
    const db = makeMemDb()
    db.upsertSubscription({ endpoint: 'https://ep1', keys: { p256dh: 'p1', auth: 'a1' } })
    db.upsertSubscription({ endpoint: 'https://ep2', keys: { p256dh: 'p2', auth: 'a2' } })
    __setDbSeam(db)
    const mockSend = vi.fn().mockResolvedValue(undefined)
    __setPushSender(mockSend)
    const r = await call('POST', '/api/push/send', JSON.stringify({ title: 'Alert', body: 'text' }))
    expect(r.status).toBe(200)
    expect(r.body.sent).toBe(2)
    expect(mockSend).toHaveBeenCalledTimes(2)
  })

  it('counts failed sends in the failed field without throwing', async () => {
    const db = makeMemDb()
    db.upsertSubscription({ endpoint: 'https://ep1', keys: { p256dh: 'p1', auth: 'a1' } })
    db.upsertSubscription({ endpoint: 'https://ep2', keys: { p256dh: 'p2', auth: 'a2' } })
    __setDbSeam(db)
    __setPushSender(vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('410 Gone')))
    const r = await call('POST', '/api/push/send', JSON.stringify({ title: 'Alert' }))
    expect(r.status).toBe(200)
    expect(r.body.sent).toBe(1)
    expect(r.body.failed).toBe(1)
  })

  it('passes title, body, and url to the sender payload', async () => {
    const db = makeMemDb()
    db.upsertSubscription({ endpoint: 'https://ep1', keys: { p256dh: 'p1', auth: 'a1' } })
    __setDbSeam(db)
    const mockSend = vi.fn().mockResolvedValue(undefined)
    __setPushSender(mockSend)
    await call('POST', '/api/push/send', JSON.stringify({ title: 'T', body: 'B', url: '/kanban' }))
    const [sub, payload] = mockSend.mock.calls[0]
    expect(sub.endpoint).toBe('https://ep1')
    const parsed = JSON.parse(payload as string)
    expect(parsed.title).toBe('T')
    expect(parsed.body).toBe('B')
    expect(parsed.url).toBe('/kanban')
  })
})
