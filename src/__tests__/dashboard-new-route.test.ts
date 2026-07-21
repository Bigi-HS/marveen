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

describe('tryHandleDashboardNew -- /v2 side-by-side serving', () => {
  it('ignores non-/v2 paths (lets the legacy web/ handler run)', () => {
    expect(call('/').handled).toBe(false)
    expect(call('/index.html').handled).toBe(false)
    expect(call('/v2extra').handled).toBe(false) // not a real /v2 boundary
    expect(call('/api/agents/health').handled).toBe(false)
  })

  it('serves index.html at the /v2 root (with and without trailing slash)', () => {
    for (const p of ['/v2', '/v2/']) {
      const r = call(p)
      expect(r.handled).toBe(true)
      expect(r.status).toBe(200)
      expect(r.body).toContain('NoA v2')
      expect(r.headers['Content-Type']).toMatch(/text\/html/)
    }
  })

  it('serves a real hashed asset with the correct content-type', () => {
    const r = call('/v2/assets/index-abc123.js')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body).toBe('console.log("app")')
    expect(r.headers['Content-Type']).toMatch(/javascript/)
  })

  it('serves woff2 fonts with a font mime (not octet-stream)', () => {
    const r = call('/v2/assets/font-xyz.woff2')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.headers['Content-Type']).toBe('font/woff2')
  })

  it('SPA-fallback: an extension-less client route serves index.html', () => {
    const r = call('/v2/gate')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body).toContain('NoA v2')
  })

  it('a missing asset request (has extension) is 404, NOT an html fallback', () => {
    const r = call('/v2/assets/missing-deadbeef.js')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(404)
    expect(r.body).not.toContain('NoA v2')
  })

  it('blocks path traversal outside dist', () => {
    const r = call('/v2/../../../etc/passwd')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(403)
  })
})
