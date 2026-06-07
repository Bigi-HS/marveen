import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const TEST_DIR = '/tmp/test-admin-rotate-token'
const TOKEN_PATH = join(TEST_DIR, 'store', '.dashboard-token')

// Redirect PROJECT_ROOT so dashboard-auth writes the token under /tmp, never the
// real store/.dashboard-token.
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, PROJECT_ROOT: TEST_DIR }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

// Ensure the env override doesn't shadow the file-backed token under test.
delete process.env.DASHBOARD_TOKEN

function makeCtx(path: string, method: string) {
  const url = new URL(`http://localhost:3420${path}`)
  let responseBody = ''
  let responseStatus = 200
  const res = {
    writeHead: (status: number, _headers?: Record<string, string>) => { responseStatus = status },
    end: (body?: string) => { responseBody = body || '' },
  }
  return {
    ctx: { req: {} as any, res: res as any, path, method, url },
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

describe('tryHandleAdmin route handler', () => {
  it('rotates the token: new token differs, is persisted, and becomes the active one', async () => {
    const { tryHandleAdmin } = await import('../web/routes/admin.js')
    const { getDashboardToken, initDashboardToken } = await import('../web/dashboard-auth.js')

    const original = 'original-token-value'
    initDashboardToken(original)
    expect(getDashboardToken()).toBe(original)

    const { ctx, getResponse } = makeCtx('/api/admin/rotate-token', 'POST')
    const handled = await tryHandleAdmin(ctx)

    expect(handled).toBe(true)
    const { status, body } = getResponse()
    expect(status).toBe(200)
    expect(body.ok).toBe(true)

    const fresh = body.token as string
    expect(typeof fresh).toBe('string')
    expect(fresh.length).toBeGreaterThan(0)
    expect(fresh).not.toBe(original)

    // In-memory active token is now the fresh one; the old one no longer matches.
    expect(getDashboardToken()).toBe(fresh)

    // Persisted to disk so a future restart picks up the rotated token.
    expect(readFileSync(TOKEN_PATH, 'utf-8').trim()).toBe(fresh)
  })

  it('GET on the rotate path is not handled (POST-only)', async () => {
    const { tryHandleAdmin } = await import('../web/routes/admin.js')
    const { ctx } = makeCtx('/api/admin/rotate-token', 'GET')
    expect(await tryHandleAdmin(ctx)).toBe(false)
  })

  it('returns false for unrelated paths', async () => {
    const { tryHandleAdmin } = await import('../web/routes/admin.js')
    const { ctx } = makeCtx('/api/memories', 'GET')
    expect(await tryHandleAdmin(ctx)).toBe(false)
  })
})
