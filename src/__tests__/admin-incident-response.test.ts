// Tests for card 456293c4 (C4): POST /api/admin/incident-response
//
// Composes rotateDashboardToken() + rotateSessionSecret() in one call so an
// operator can invalidate both the bearer token AND all browser sessions in a
// single request during an incident.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const TEST_DIR = '/tmp/test-admin-incident-response'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, PROJECT_ROOT: TEST_DIR }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

delete process.env.DASHBOARD_TOKEN

function makeCtx(path: string, method: string) {
  const url = new URL(`http://localhost:3420${path}`)
  let responseBody = ''
  let responseStatus = 200
  const res = {
    writeHead: (status: number) => { responseStatus = status },
    end: (body?: string) => { responseBody = body || '' },
  }
  return {
    ctx: { req: {} as any, res: res as any, path, method, url, identity: { agentId: 'operator', scopes: ['admin:*'], source: 'operator' as const } },
    getResponse: () => ({ status: responseStatus, body: responseBody ? JSON.parse(responseBody) : null }),
  }
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(join(TEST_DIR, 'store'), { recursive: true })
})

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('POST /api/admin/incident-response (card 456293c4)', () => {
  it('rotates the bearer token (new token in response body)', async () => {
    const { tryHandleAdmin } = await import('../web/routes/admin.js')
    const { getDashboardToken, initDashboardToken } = await import('../web/dashboard-auth.js')

    const original = 'original-incident-test-token'
    initDashboardToken(original)

    const { ctx, getResponse } = makeCtx('/api/admin/incident-response', 'POST')
    await tryHandleAdmin(ctx)

    const { status, body } = getResponse()
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(typeof body.token).toBe('string')
    expect(body.token).not.toBe(original)
    expect(getDashboardToken()).toBe(body.token)
  })

  it('rotates the session secret (rotateSessionSecret called)', async () => {
    const dashboardAuth = await import('../web/dashboard-auth.js')
    const spy = vi.spyOn(dashboardAuth, 'rotateSessionSecret')

    const { tryHandleAdmin } = await import('../web/routes/admin.js')
    const { ctx } = makeCtx('/api/admin/incident-response', 'POST')
    await tryHandleAdmin(ctx)

    expect(spy).toHaveBeenCalledOnce()
    spy.mockRestore()
  })

  it('GET is not handled (POST-only)', async () => {
    const { tryHandleAdmin } = await import('../web/routes/admin.js')
    const { ctx } = makeCtx('/api/admin/incident-response', 'GET')
    expect(await tryHandleAdmin(ctx)).toBe(false)
  })

  it('does not interfere with existing /api/admin/rotate-token or /api/admin/logout-all', async () => {
    const { tryHandleAdmin } = await import('../web/routes/admin.js')
    const { initDashboardToken } = await import('../web/dashboard-auth.js')
    initDashboardToken('some-token')

    expect(await tryHandleAdmin(makeCtx('/api/admin/rotate-token', 'POST').ctx)).toBe(true)
    expect(await tryHandleAdmin(makeCtx('/api/admin/logout-all', 'POST').ctx)).toBe(true)
    expect(await tryHandleAdmin(makeCtx('/api/admin/incident-response', 'POST').ctx)).toBe(true)
  })
})
