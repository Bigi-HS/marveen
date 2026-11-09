// Tests for POST /api/push/subscribe and POST /api/push/send
// TDD: tests written before implementation (card 044a8f5f).
// Covers route guard, JSON validation, auth guards, DB seam, and VAPID-send seam.
// Live push delivery (actual web-push over the wire) is excluded -- network-free.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import {
  tryHandlePush,
  __setPushSender,
  __setDbSeam,
  type PushSubscription,
} from '../web/routes/push.js'
import type { AgentIdentity } from '../web/agent-token-registry.js'

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const ANON_IDENTITY: AgentIdentity = { agentId: '', scopes: [], source: 'agent' }
const OPERATOR_IDENTITY: AgentIdentity = { agentId: 'marveen', scopes: ['admin:*'], source: 'operator' }
const AGENT_IDENTITY: AgentIdentity = { agentId: 'dave', scopes: [], source: 'agent' }

async function call(
  method: string,
  path: string,
  rawBody?: string,
  identity: AgentIdentity = ANON_IDENTITY,
  remoteAddress = '127.0.0.1',
) {
  const url = new URL('http://x' + path)
  const req = Object.assign(
    Readable.from(rawBody === undefined ? [] : [Buffer.from(rawBody)]),
    { socket: { remoteAddress } },
  ) as never
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
  const handled = await tryHandlePush({ req, res, method, path: url.pathname, url, identity } as never)
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
// POST /api/push/subscribe -- auth guard
// ---------------------------------------------------------------------------

describe('POST /api/push/subscribe -- auth', () => {
  it('rejects anonymous identity with 403 (fail-closed)', async () => {
    const r = await call('POST', '/api/push/subscribe', '{}', ANON_IDENTITY)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(403)
  })

  it('allows operator identity', async () => {
    const db = makeMemDb()
    __setDbSeam(db)
    const body = JSON.stringify({
      endpoint: 'https://push.example.com/sub1',
      keys: { p256dh: 'BNFvtest1', auth: 'authtest1' },
    })
    const r = await call('POST', '/api/push/subscribe', body, OPERATOR_IDENTITY)
    expect(r.status).toBe(201)
  })

  it('allows agent identity (any authenticated agent may register its browser)', async () => {
    const db = makeMemDb()
    __setDbSeam(db)
    const body = JSON.stringify({
      endpoint: 'https://push.example.com/sub2',
      keys: { p256dh: 'BNFvtest2', auth: 'authtest2' },
    })
    const r = await call('POST', '/api/push/subscribe', body, AGENT_IDENTITY)
    expect(r.status).toBe(201)
  })
})

// ---------------------------------------------------------------------------
// POST /api/push/subscribe -- validation
// ---------------------------------------------------------------------------

describe('POST /api/push/subscribe -- validation', () => {
  it('rejects invalid JSON with 400', async () => {
    const r = await call('POST', '/api/push/subscribe', '{bad json', OPERATOR_IDENTITY)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/invalid JSON/i)
  })

  it('rejects missing endpoint with 400', async () => {
    const body = JSON.stringify({ keys: { p256dh: 'abc', auth: 'xyz' } })
    const r = await call('POST', '/api/push/subscribe', body, OPERATOR_IDENTITY)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/endpoint/i)
  })

  it('rejects non-https endpoint with 400', async () => {
    const body = JSON.stringify({ endpoint: 'http://insecure.example.com/sub', keys: { p256dh: 'abc', auth: 'xyz' } })
    const r = await call('POST', '/api/push/subscribe', body, OPERATOR_IDENTITY)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/endpoint/i)
  })

  it('rejects non-URL endpoint with 400', async () => {
    const body = JSON.stringify({ endpoint: 'not-a-url', keys: { p256dh: 'abc', auth: 'xyz' } })
    const r = await call('POST', '/api/push/subscribe', body, OPERATOR_IDENTITY)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/endpoint/i)
  })

  it('rejects missing keys.p256dh with 400', async () => {
    const body = JSON.stringify({ endpoint: 'https://push.example.com/sub1', keys: { auth: 'xyz' } })
    const r = await call('POST', '/api/push/subscribe', body, OPERATOR_IDENTITY)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/p256dh/i)
  })

  it('rejects missing keys.auth with 400', async () => {
    const body = JSON.stringify({ endpoint: 'https://push.example.com/sub1', keys: { p256dh: 'abc' } })
    const r = await call('POST', '/api/push/subscribe', body, OPERATOR_IDENTITY)
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
    const r = await call('POST', '/api/push/subscribe', body, OPERATOR_IDENTITY)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(201)
    expect(r.body.ok).toBe(true)
    expect(db._subs.has('https://push.example.com/sub1')).toBe(true)
  })

  it('upserts (re-register same endpoint returns 201 again)', async () => {
    const db = makeMemDb()
    __setDbSeam(db)
    const sub = { endpoint: 'https://push.example.com/sub1', keys: { p256dh: 'B1', auth: 'A1' } }
    await call('POST', '/api/push/subscribe', JSON.stringify(sub), OPERATOR_IDENTITY)
    const sub2 = { ...sub, keys: { p256dh: 'B2', auth: 'A2' } }
    const r = await call('POST', '/api/push/subscribe', JSON.stringify(sub2), OPERATOR_IDENTITY)
    expect(r.status).toBe(201)
    expect(db._subs.get('https://push.example.com/sub1')!.keys.p256dh).toBe('B2')
  })
})

// ---------------------------------------------------------------------------
// POST /api/push/send -- auth guard
// ---------------------------------------------------------------------------

describe('POST /api/push/send -- auth', () => {
  it('rejects anonymous identity with 403 (fail-closed)', async () => {
    const r = await call('POST', '/api/push/send', JSON.stringify({ title: 'x' }), ANON_IDENTITY)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(403)
  })

  it('rejects non-admin agent identity with 403', async () => {
    const r = await call('POST', '/api/push/send', JSON.stringify({ title: 'x' }), AGENT_IDENTITY)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/admin/i)
  })

  it('allows operator (admin:*) identity', async () => {
    const db = makeMemDb()
    __setDbSeam(db)
    __setPushSender(vi.fn().mockResolvedValue(undefined))
    const r = await call('POST', '/api/push/send', JSON.stringify({ title: 'Hey' }), OPERATOR_IDENTITY)
    expect(r.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// POST /api/push/send -- logic
// ---------------------------------------------------------------------------

describe('POST /api/push/send -- logic', () => {
  it('rejects invalid JSON with 400', async () => {
    const r = await call('POST', '/api/push/send', 'not json', OPERATOR_IDENTITY)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(400)
  })

  it('rejects missing title with 400', async () => {
    const r = await call('POST', '/api/push/send', JSON.stringify({ body: 'hi' }), OPERATOR_IDENTITY)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/title/i)
  })

  it('returns 200 with sent=0 when no subscriptions are registered', async () => {
    const db = makeMemDb()
    __setDbSeam(db)
    __setPushSender(vi.fn().mockResolvedValue(undefined))
    const r = await call('POST', '/api/push/send', JSON.stringify({ title: 'Hey', body: 'msg' }), OPERATOR_IDENTITY)
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
    const r = await call('POST', '/api/push/send', JSON.stringify({ title: 'Alert', body: 'text' }), OPERATOR_IDENTITY)
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
    const r = await call('POST', '/api/push/send', JSON.stringify({ title: 'Alert' }), OPERATOR_IDENTITY)
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
    await call('POST', '/api/push/send', JSON.stringify({ title: 'T', body: 'B', url: '/kanban' }), OPERATOR_IDENTITY)
    const [sub, payload] = mockSend.mock.calls[0]
    expect(sub.endpoint).toBe('https://ep1')
    const parsed = JSON.parse(payload as string)
    expect(parsed.title).toBe('T')
    expect(parsed.body).toBe('B')
    expect(parsed.url).toBe('/kanban')
  })
})
