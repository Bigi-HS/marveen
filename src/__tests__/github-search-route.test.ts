import { describe, it, expect, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import {
  tryHandleGithubSearch,
  __setPatReader,
  clampGithubMax,
} from '../web/routes/github-search.js'

// Drives the route handler with a fake req/res (same pattern as notify-route.test.ts).
// Covers only the network-free branches: path/method guard, q validation, and the
// PAT-missing 503. The actual GitHub fetch (502/network) is exercised by the live
// smoke, not here.
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
  const handled = await tryHandleGithubSearch({ req, res, method, path: url.pathname, url } as never)
  return { handled, ...captured }
}

afterEach(() => __setPatReader(null))

describe('GET /api/github-search (route guard + validation)', () => {
  it('does not handle a non-matching path', async () => {
    const r = await call('GET', '/api/other')
    expect(r.handled).toBe(false)
  })

  it('does not handle POST on the github-search path', async () => {
    const r = await call('POST', '/api/github-search?q=x')
    expect(r.handled).toBe(false)
  })

  it('rejects a missing q with 400', async () => {
    const r = await call('GET', '/api/github-search')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/q parameter required/)
  })

  it('rejects a blank (whitespace-only) q with 400', async () => {
    const r = await call('GET', '/api/github-search?q=%20%20')
    expect(r.status).toBe(400)
  })

  it('rejects a q over 500 chars with 400', async () => {
    const long = 'a'.repeat(501)
    const r = await call('GET', '/api/github-search?q=' + long)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/500 character/)
  })

  it('returns 503 when the PAT is not configured', async () => {
    __setPatReader(() => null)
    const r = await call('GET', '/api/github-search?q=claude')
    expect(r.status).toBe(503)
    expect(r.body.error).toMatch(/PAT not configured/)
  })
})

describe('clampGithubMax', () => {
  it('defaults NaN to 10', () => {
    expect(clampGithubMax(NaN)).toBe(10)
  })

  it('clamps below 1 up to 1', () => {
    expect(clampGithubMax(0)).toBe(1)
    expect(clampGithubMax(-5)).toBe(1)
  })

  it('clamps above 30 down to 30', () => {
    expect(clampGithubMax(100)).toBe(30)
  })

  it('passes an in-range value through', () => {
    expect(clampGithubMax(1)).toBe(1)
    expect(clampGithubMax(15)).toBe(15)
    expect(clampGithubMax(30)).toBe(30)
  })
})
