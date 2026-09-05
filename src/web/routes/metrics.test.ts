import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { tryHandleMetrics } from './metrics.js'
import type { RouteContext } from './types.js'

describe('metrics routes', () => {
  const metricsDir = '/tmp/metrics'
  const stateFile = join(metricsDir, '.listener-state.json')

  beforeEach(() => {
    try {
      mkdirSync(metricsDir, { recursive: true })
    } catch {
      // dir may already exist
    }
  })

  afterEach(() => {
    try {
      unlinkSync(stateFile)
    } catch {
      // file may not exist
    }
  })

  it('GET /api/metrics/listener-status returns listener state', async () => {
    const mockState = {
      connected: true,
      last_event_ts: Date.now(),
      event_count: 42,
      reconnects: 2,
      uptime_s: 3600,
    }
    writeFileSync(stateFile, JSON.stringify(mockState))

    const responseData: any = {}
    const ctx: RouteContext = {
      path: '/api/metrics/listener-status',
      method: 'GET',
      url: 'http://dummy/api/metrics/listener-status',
      res: {
        writeHead: () => {},
        end: (data: string) => {
          Object.assign(responseData, JSON.parse(data))
        },
      } as any,
    }

    const handled = await tryHandleMetrics(ctx)
    expect(handled).toBe(true)
    expect(responseData.connected).toBe(true)
    expect(responseData.event_count).toBe(42)
    expect(responseData.reconnects).toBe(2)
  })

  it('GET /api/metrics/listener-status returns 503 if state file missing', async () => {
    const statusData: any = {}
    const ctx: RouteContext = {
      path: '/api/metrics/listener-status',
      method: 'GET',
      url: 'http://dummy/api/metrics/listener-status',
      res: {
        statusCode: 200,
        writeHead: (code: number) => {
          statusData.code = code
        },
        end: (data: string) => {
          Object.assign(statusData, JSON.parse(data))
        },
      } as any,
    }

    const handled = await tryHandleMetrics(ctx)
    expect(handled).toBe(true)
    expect(statusData.code).toBe(503)
    expect(statusData.status).toBe('offline')
  })
})
