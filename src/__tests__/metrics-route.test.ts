import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { tryHandleMetrics } from '../web/routes/metrics.js'

// Mock the filesystem
vi.mock('node:fs', async () => {
  const real = await vi.importActual('node:fs')
  return {
    ...real,
    readFileSync: vi.fn((path: string) => {
      // Mock /tmp/metrics/pr-123/ with sample data
      if (path === '/tmp/metrics/pr-123/coverage.json') {
        return JSON.stringify({
          pct: 83.1,
          delta: -1.2,
          prev_pct: 84.3,
          worst_file: 'src/web/dashboard.ts',
          worst_file_delta: -5.0,
          uncovered_lines_added: 12,
        })
      }
      if (path === '/tmp/metrics/pr-123/flaky-report.json') {
        return JSON.stringify({
          runs: 10,
          completed: 10,
          suite_passed: 8,
          suite_failed: 2,
          tests: {
            'channel-monitor.spec.ts > reconnect': {
              passed: 7,
              failed: 3,
              flaky: true,
              fail_rate: '3/10',
            },
          },
          flaky_tests: ['channel-monitor.spec.ts > reconnect'],
          duration_s: 44.2,
        })
      }
      // For missing PR, throw ENOENT
      const err = new Error('ENOENT: no such file or directory') as any
      err.code = 'ENOENT'
      throw err
    }),
  }
})

async function call(method: string, fullPath: string, body?: unknown) {
  const url = new URL('http://x' + fullPath)
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any
  const captured: { status: number; body: any; headers: Record<string, string> } = {
    status: 0,
    body: undefined,
    headers: {},
  }
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status
      if (headers) captured.headers = headers
      return res
    },
    end(b?: string) {
      captured.body = b ? JSON.parse(b) : undefined
    },
    setHeader() {
      return res
    },
  } as any
  const handled = await tryHandleMetrics({
    req,
    res,
    method,
    path: url.pathname,
    url,
    identity: { agentId: 'test', scopes: [], source: 'agent' },
  } as any)
  return { handled, ...captured }
}

describe('metrics route — GET /api/metrics/coverage', () => {
  it('returns 400 if pr parameter is missing', async () => {
    const r = await call('GET', '/api/metrics/coverage')
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/Missing pr parameter/i)
    expect(r.handled).toBe(true)
  })

  it('returns 400 if pr parameter is not a valid integer', async () => {
    const r = await call('GET', '/api/metrics/coverage?pr=abc')
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/Invalid pr parameter/i)
    expect(r.handled).toBe(true)
  })

  it('returns 400 if pr parameter is zero or negative', async () => {
    let r = await call('GET', '/api/metrics/coverage?pr=0')
    expect(r.status).toBe(400)

    r = await call('GET', '/api/metrics/coverage?pr=-5')
    expect(r.status).toBe(400)
  })

  it('returns 200 with coverage + flaky data for valid PR with both files', async () => {
    const r = await call('GET', '/api/metrics/coverage?pr=123')
    expect(r.status).toBe(200)
    expect(r.body.pr_num).toBe(123)
    expect(r.body.coverage).toBeDefined()
    expect(r.body.coverage.pct).toBe(83.1)
    expect(r.body.coverage.delta).toBe(-1.2)
    expect(r.body.coverage.worst_file).toBe('src/web/dashboard.ts')
    expect(r.body.flaky).toBeDefined()
    expect(r.body.flaky.count).toBe(1)
    expect(r.body.flaky.list).toHaveLength(1)
    expect(r.body.flaky.list[0].test).toBe('channel-monitor.spec.ts > reconnect')
    expect(r.body.flaky.list[0].fail_rate).toBe('3/10')
    expect(r.body.trend.runtime_s).toBe(44.2)
    expect(r.body.measured_by).toBe('dampier')
    expect(r.handled).toBe(true)
  })

  it('returns 404 if neither coverage.json nor flaky-report.json exist', async () => {
    const r = await call('GET', '/api/metrics/coverage?pr=999')
    expect(r.status).toBe(404)
    expect(r.body.error).toMatch(/No metrics found/i)
    expect(r.handled).toBe(true)
  })

  it('ignores routes other than /api/metrics/coverage', async () => {
    const r = await call('GET', '/api/other?pr=123')
    expect(r.handled).toBe(false)
  })

  it('only handles GET requests', async () => {
    const r = await call('POST', '/api/metrics/coverage?pr=123')
    expect(r.handled).toBe(false)
  })
})
