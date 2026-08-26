// POST /api/health/ingest-raw n8n proxy -- error-mirror leak guard (Chad medium, PR#541 follow-up).
// The proxy must NOT reflect n8n's internal error body/detail to the unauthenticated public caller;
// a non-2xx from n8n yields a generic error. A 2xx success is forwarded (it is our own ingest reply).

import { describe, it, expect, vi, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tryHandleHealthIngestRaw } from '../web/routes/health-ingest-raw.js'
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
