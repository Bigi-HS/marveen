import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tryHandleDashboardNew } from '../web/routes/dashboard-new.js'

const DIST = '/tmp/test-dashnew-dist'

beforeAll(() => {
  rmSync(DIST, { recursive: true, force: true })
  mkdirSync(join(DIST, 'assets'), { recursive: true })
  writeFileSync(join(DIST, 'index.html'), '<!doctype html><title>NoA v2</title>')
  writeFileSync(join(DIST, 'assets', 'index-abc123.js'), 'console.log("app")')
  writeFileSync(join(DIST, 'assets', 'font-xyz.woff2'), 'WOFF2BYTES')
})
afterAll(() => rmSync(DIST, { recursive: true, force: true }))

// Mirrors the mock-res convention used by the other route tests: capture the
// status, headers, and the raw body serveFile writes.
function call(path: string) {
  const captured: { status: number; headers: Record<string, string>; body: string } = {
    status: 200,
    headers: {},
    body: '',
  }
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status
      if (headers) captured.headers = headers
      return res
    },
    end(b?: Buffer | string) {
      captured.body = b ? b.toString() : ''
    },
  } as never
  const handled = tryHandleDashboardNew({ res, path } as never, DIST)
  return { handled, ...captured }
}

// ROOT FLIP (card 2d70c06e): SPA now serves '/', /v2 -> / redirect.
describe('tryHandleDashboardNew -- ROOT FLIP: SPA on /', () => {
  it('serves index.html at / (with and without trailing slash)', () => {
    for (const p of ['/', '']) {
      const r = call(p)
      expect(r.handled).toBe(true)
      expect(r.status).toBe(200)
      expect(r.body).toContain('NoA v2')
      expect(r.headers['Content-Type']).toMatch(/text\/html/)
    }
  })

  it('serves a real hashed asset at /assets/* with the correct content-type', () => {
    const r = call('/assets/index-abc123.js')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body).toBe('console.log("app")')
    expect(r.headers['Content-Type']).toMatch(/javascript/)
  })

  it('serves woff2 fonts with a font mime (not octet-stream)', () => {
    const r = call('/assets/font-xyz.woff2')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.headers['Content-Type']).toBe('font/woff2')
  })

  it('SPA-fallback: an extension-less client route serves index.html', () => {
    const r = call('/gate')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body).toContain('NoA v2')
  })

  it('a missing asset request (has extension) is 404, NOT an html fallback', () => {
    const r = call('/assets/missing-deadbeef.js')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(404)
    expect(r.body).not.toContain('NoA v2')
  })

  it('blocks path traversal outside dist', () => {
    const r = call('/../../../etc/passwd')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(403)
  })

  it('/v2 and /v2/ redirect 301 to /', () => {
    for (const p of ['/v2', '/v2/']) {
      const r = call(p)
      expect(r.handled).toBe(true)
      expect(r.status).toBe(301)
      expect(r.headers['Location']).toBe('/')
    }
  })

  it('/v2/* redirects 301 to the equivalent / path', () => {
    const r = call('/v2/gate')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(301)
    expect(r.headers['Location']).toBe('/gate')
  })

  it('/v2extra is NOT a /v2 boundary -- treated as SPA client route', () => {
    const r = call('/v2extra')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body).toContain('NoA v2')
  })
})
