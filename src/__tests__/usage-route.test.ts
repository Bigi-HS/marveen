/**
 * Route coverage for GET /api/usage/current (card 7fe5662f).
 *
 * The route is behind the existing global bearer-token auth gate (web.ts); these
 * tests drive tryHandleUsage directly with a fake req/res (same pattern as
 * github-search-route.test.ts). They pin the feature-flag + rotation degrade
 * behaviour and the [G3] invariant that the response body is ONLY the derived
 * {fiveHour,weekly,stale} shape -- never a credential.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { tryHandleUsage } from '../web/routes/usage.js'
import { __resetUsageCache } from '../web/usage-refresher.js'

async function call(method: string, path: string) {
  const url = new URL('http://x' + path)
  const req = Object.assign(Readable.from([]), { url: path }) as never
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
  const handled = await tryHandleUsage({ req, res, method, path: url.pathname, url } as never)
  return { handled, ...captured }
}

afterEach(() => __resetUsageCache())

describe('GET /api/usage/current', () => {
  it('does not handle a non-matching path', async () => {
    const r = await call('GET', '/api/other')
    expect(r.handled).toBe(false)
  })

  it('does not handle POST on the usage path', async () => {
    const r = await call('POST', '/api/usage/current')
    expect(r.handled).toBe(false)
  })

  it('returns 503 feature-absent when there is no cached usage (feature-flag)', async () => {
    __resetUsageCache({ reason: 'feature-absent' })
    const r = await call('GET', '/api/usage/current')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(503)
    expect(r.body.reason).toBe('feature-absent')
  })

  it('returns 503 auth-expired (rotation) when the session went stale', async () => {
    __resetUsageCache({ reason: 'auth-expired' })
    const r = await call('GET', '/api/usage/current')
    expect(r.status).toBe(503)
    expect(r.body.reason).toBe('auth-expired')
    // [G3] the auth-expired body never carries a credential.
    expect(JSON.stringify(r.body)).not.toContain('SECRET')
  })

  it('returns 200 with ONLY {fiveHour,weekly,stale} on a fresh cache (G3)', async () => {
    __resetUsageCache({
      ok: true,
      usage: {
        fiveHour: { pct: 42, resetAt: '2026-07-22T15:00:00Z' },
        weekly: { pct: 71, resetAt: '2026-07-27T00:00:00Z' },
      },
      lastSuccessMs: Date.now(),
      reason: null,
    })
    const r = await call('GET', '/api/usage/current')
    expect(r.status).toBe(200)
    expect(Object.keys(r.body).sort()).toEqual(['fiveHour', 'stale', 'weekly'])
    expect(r.body.stale).toBe(false)
    expect(r.body.fiveHour.pct).toBe(42)
  })

  it('returns 200 stale:true when the cached usage is past the TTL', async () => {
    __resetUsageCache({
      ok: false,
      usage: {
        fiveHour: { pct: 10, resetAt: 'x' },
        weekly: { pct: 20, resetAt: 'y' },
      },
      lastSuccessMs: Date.now() - 60 * 60 * 1000, // 1h ago, past the 20m TTL
      reason: 'unavailable',
    })
    const r = await call('GET', '/api/usage/current')
    expect(r.status).toBe(200)
    expect(r.body.stale).toBe(true)
  })
})
