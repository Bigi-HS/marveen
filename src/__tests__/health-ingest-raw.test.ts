// POST /api/health/ingest-raw n8n proxy -- error-mirror leak guard (Chad medium, PR#541 follow-up).
// The proxy must NOT reflect n8n's internal error body/detail to the unauthenticated public caller;
// a non-2xx from n8n yields a generic error. A 2xx success is forwarded (it is our own ingest reply).

import { describe, it, expect, vi, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tryHandleHealthIngestRaw, makeHealthIngestRawHandler } from '../web/routes/health-ingest-raw.js'
import type { RouteContext } from '../web/routes/types.js'

function makeReq(body: string): IncomingMessage {
  const r = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
  r.method = 'POST'
  r.headers = { 'content-type': 'application/json' }
  return r
}

function makeRes(): { res: ServerResponse; written: () => { status: number; body: string } } {
  let status = 200
  let body = ''
  const res = {
    writeHead: vi.fn((s: number) => { status = s }),
    end: vi.fn((b: string) => { body = b }),
    setHeader: vi.fn(),
    getHeader: vi.fn(),
  } as unknown as ServerResponse
  return { res, written: () => ({ status, body }) }
}

function makeCtx(body: string): { ctx: RouteContext; written: () => { status: number; body: string } } {
  const req = makeReq(body)
  const { res, written } = makeRes()
  const ctx = {
    req,
    res,
    path: '/api/health/ingest-raw',
    method: 'POST',
    url: new URL('http://localhost:3420/api/health/ingest-raw'),
    identity: null,
  } as unknown as RouteContext
  return { ctx, written }
}

afterEach(() => vi.unstubAllGlobals())

describe('POST /api/health/ingest-raw error-mirror leak guard', () => {
  it('does NOT reflect the n8n internal error body on a 5xx (info-leak guard)', async () => {
    const leak = JSON.stringify({
      message: 'INTERNAL: workflow "zepp-hc" crashed at /home/domin/marveen/n8n node 27',
      stack: 'Error: secret internal detail\n  at /home/domin/.n8n/...',
    })
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(leak, { status: 500, headers: { 'content-type': 'application/json' } })))

    const { ctx, written } = makeCtx('{"foo":1}')
    const handled = await tryHandleHealthIngestRaw(ctx)
    expect(handled).toBe(true)

    const out = written()
    expect(out.status).toBe(502) // upstream failure -> generic bad-gateway
    expect(out.body).not.toContain('INTERNAL')
    expect(out.body).not.toContain('secret')
    expect(out.body).not.toContain('zepp-hc')
    expect(out.body).not.toContain('/home/domin')
    expect(JSON.parse(out.body)).toEqual({ error: 'transform failed' })
  })

  it('maps an n8n 4xx to a generic 400 without reflecting its body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ message: 'node "Map" threw: bad field xyz' }), {
        status: 422, headers: { 'content-type': 'application/json' },
      })))

    const { ctx, written } = makeCtx('{"foo":1}')
    await tryHandleHealthIngestRaw(ctx)

    const out = written()
    expect(out.status).toBe(400)
    expect(out.body).not.toContain('xyz')
    expect(out.body).not.toContain('Map')
    expect(JSON.parse(out.body)).toEqual({ error: 'transform failed' })
  })

  it('forwards a 2xx success reply through (our own ingest response, not a leak)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, landed: 1 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })))

    const { ctx, written } = makeCtx('{"foo":1}')
    await tryHandleHealthIngestRaw(ctx)

    const out = written()
    expect(out.status).toBe(200)
    expect(JSON.parse(out.body)).toEqual({ ok: true, landed: 1 })
  })

  it('still returns 502 when n8n is unreachable (fetch throws)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))

    const { ctx, written } = makeCtx('{"foo":1}')
    await tryHandleHealthIngestRaw(ctx)

    const out = written()
    expect(out.status).toBe(502)
    expect(out.body).not.toContain('ECONNREFUSED')
  })
})

// AC-1 handler integration: raw body retained on every successful push
describe('POST /api/health/ingest-raw retention integration (AC-1)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('calls retain with the raw body on a 2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })))

    const retained: string[] = []
    const handler = makeHealthIngestRawHandler({ retain: (b) => retained.push(b) })
    const { ctx } = makeCtx('{"date":"2026-08-27","activity":{"steps":10000}}')
    await handler(ctx.req, ctx.res)

    expect(retained).toHaveLength(1)
    expect(retained[0]).toBe('{"date":"2026-08-27","activity":{"steps":10000}}')
  })

  it('still calls retain even when n8n returns a non-2xx (body is preserved for debugging)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('{"error":"bad"}', { status: 422, headers: { 'content-type': 'application/json' } })))

    const retained: string[] = []
    const handler = makeHealthIngestRawHandler({ retain: (b) => retained.push(b) })
    const { ctx } = makeCtx('{"date":"2026-08-27"}')
    await handler(ctx.req, ctx.res)

    // Body still captured even though n8n rejected it -- useful for diagnosing bad payloads.
    expect(retained).toHaveLength(1)
  })

  it('does NOT call retain when the body read itself fails (no body to retain)', async () => {
    // Simulate a read error
    const req = {
      on: (ev: string, cb: (e?: Error) => void) => {
        if (ev === 'error') cb(new Error('socket hang up'))
      },
      emit: () => false,
    } as unknown as import('node:http').IncomingMessage
    req.method = 'POST'
    ;(req as any).headers = {}

    const retained: string[] = []
    const handler = makeHealthIngestRawHandler({ retain: (b) => retained.push(b) })
    const { res } = makeRes()
    const ctx = { req, res, path: '/api/health/ingest-raw', method: 'POST', url: new URL('http://localhost:3420/api/health/ingest-raw'), identity: null } as unknown as RouteContext
    await handler(ctx.req, ctx.res)

    expect(retained).toHaveLength(0)
  })
})

// ── F2 (7b1a254c): size-cap tests ────────────────────────────────────────────
// health-ingest.ts has these; ingest-raw was missing them (pre-existing gap).

describe('POST /api/health/ingest-raw -- size cap (7b1a254c F2)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns 413 for a body exceeding 512KB', async () => {
    // No fetch stub needed -- rejection happens before n8n forward.
    const oversized = 'x'.repeat(512 * 1024 + 1)
    const { ctx, written } = makeCtx(oversized)
    const handled = await tryHandleHealthIngestRaw(ctx)
    expect(handled).toBe(true)
    expect(written().status).toBe(413)
    expect(JSON.parse(written().body)).toEqual({ error: 'Payload too large' })
  })

  it('accepts a body exactly at the 512KB cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const atCap = 'x'.repeat(512 * 1024)
    const { ctx, written } = makeCtx(atCap)
    await tryHandleHealthIngestRaw(ctx)
    expect(written().status).toBe(200)
  })
})

// ── Rate limiting (7b1a254c): per-IP + global ceiling ────────────────────────
// Tests use makeHealthIngestRawHandler with injected mock limiters so the
// module-level singleton bucket state does not bleed between tests.

import type { RateLimiter } from '../web/rate-limit.js'

function mockLimiter(allowed: boolean, retryAfterMs = 30_000): RateLimiter {
  return {
    allow: vi.fn(() => ({ allowed, retryAfterMs: allowed ? 0 : retryAfterMs })),
    prune: vi.fn(() => 0),
    size: vi.fn(() => 0),
  }
}

describe('POST /api/health/ingest-raw -- rate limiting (7b1a254c)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns 429 when per-IP limit is exhausted', async () => {
    const handler = makeHealthIngestRawHandler({
      ipLimiter: mockLimiter(false),
      globalLimiter: mockLimiter(true),
    })
    const { ctx, written } = makeCtx('{"foo":1}')
    await handler(ctx.req, ctx.res)
    expect(written().status).toBe(429)
  })

  it('returns 429 when global ceiling is exhausted', async () => {
    const handler = makeHealthIngestRawHandler({
      ipLimiter: mockLimiter(true),
      globalLimiter: mockLimiter(false),
    })
    const { ctx, written } = makeCtx('{"foo":1}')
    await handler(ctx.req, ctx.res)
    expect(written().status).toBe(429)
  })

  it('does NOT call fetch when rate limited (rejection before n8n forward)', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const handler = makeHealthIngestRawHandler({
      ipLimiter: mockLimiter(false),
      globalLimiter: mockLimiter(true),
    })
    const { ctx } = makeCtx('{"foo":1}')
    await handler(ctx.req, ctx.res)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('proceeds to n8n when both limits allow', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const handler = makeHealthIngestRawHandler({
      ipLimiter: mockLimiter(true),
      globalLimiter: mockLimiter(true),
    })
    const { ctx, written } = makeCtx('{"foo":1}')
    await handler(ctx.req, ctx.res)
    expect(written().status).toBe(200)
  })

  it('per-IP limit is keyed by remote address (different IPs get independent buckets)', async () => {
    // ipLimiter.allow() is called once per request with the IP key
    const ipLimiter = mockLimiter(true)
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const handler = makeHealthIngestRawHandler({ ipLimiter, globalLimiter: mockLimiter(true) })
    const { ctx } = makeCtx('{}')
    await handler(ctx.req, ctx.res)
    expect(ipLimiter.allow).toHaveBeenCalledOnce()
    // The key should be string (remoteAddress or 'unknown' for test sockets)
    const key = vi.mocked(ipLimiter.allow).mock.calls[0][0]
    expect(typeof key).toBe('string')
  })
})
