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

// Regression: the ADMIN_SCOPE guard must apply ONLY to /api/admin/* paths, not
// to every request that passes through this handler on the dispatch chain
// (card f3016e22; regression fe2dc87 ran the guard before the path check, 403ing
// all non-admin paths -- including static UI assets -- and taking the whole
// browser UI down). Build ctx with a NON-admin identity to exercise the guard.
function makeCtxWithIdentity(path: string, method: string, identity: { agentId: string; scopes: string[]; source: 'operator' | 'agent' }) {
  const url = new URL(`http://localhost:3420${path}`)
  let responseBody = ''
  let responseStatus = 200
  const res = {
    writeHead: (status: number) => { responseStatus = status },
    end: (body?: string) => { responseBody = body || '' },
  }
  return {
    ctx: { req: {} as any, res: res as any, path, method, url, identity },
    getResponse: () => ({ status: responseStatus, body: responseBody ? JSON.parse(responseBody) : null }),
  }
}

const ANON = { agentId: '', scopes: [] as string[], source: 'agent' as const } // the non-/api placeholder identity
const PER_AGENT = { agentId: 'dave', scopes: ['memory:write'] as string[], source: 'agent' as const }
const ADMIN = { agentId: 'marveen', scopes: ['admin:*'] as string[], source: 'operator' as const }

describe('admin scope guard is path-scoped (f3016e22)', () => {
  // parked-FN (the bug): a non-admin path with the anonymous placeholder
  // identity must FALL THROUGH (return false), never 403 -- this is the static
  // UI / login page the regression killed.
  it('falls through (false) for a static/non-api path with anonymous identity', async () => {
    const { tryHandleAdmin } = await import('../web/routes/admin.js')
    for (const p of ['/', '/index.html', '/assets/app.js']) {
      const { ctx, getResponse } = makeCtxWithIdentity(p, 'GET', ANON)
      expect(await tryHandleAdmin(ctx)).toBe(false)
      expect(getResponse().status).toBe(200) // res untouched -> no 403 written
    }
  })

  it('falls through (false) for a non-admin /api path with a per-agent identity', async () => {
    const { tryHandleAdmin } = await import('../web/routes/admin.js')
    const { ctx } = makeCtxWithIdentity('/api/agents', 'GET', PER_AGENT)
    expect(await tryHandleAdmin(ctx)).toBe(false)
  })

  // FP guard: the scope enforcement on REAL admin endpoints must still hold.
  it('still 403s a per-agent identity on a real /api/admin/* path', async () => {
    const { tryHandleAdmin } = await import('../web/routes/admin.js')
    const { ctx, getResponse } = makeCtxWithIdentity('/api/admin/rotate-token', 'POST', PER_AGENT)
    expect(await tryHandleAdmin(ctx)).toBe(true)
    const { status, body } = getResponse()
    expect(status).toBe(403)
    expect(body.error).toBe('admin scope required')
  })

  it('still 403s an anonymous identity on a real /api/admin/* path', async () => {
    const { tryHandleAdmin } = await import('../web/routes/admin.js')
    const { ctx, getResponse } = makeCtxWithIdentity('/api/admin/logout-all', 'POST', ANON)
    expect(await tryHandleAdmin(ctx)).toBe(true)
    expect(getResponse().status).toBe(403)
  })

  // opposing-combination: admin identity on a NON-admin path still falls
  // through (the guard must not accidentally handle non-admin paths for anyone).
  it('admin identity on a non-admin path falls through (false)', async () => {
    const { tryHandleAdmin } = await import('../web/routes/admin.js')
    const { ctx } = makeCtxWithIdentity('/api/overview', 'GET', ADMIN)
    expect(await tryHandleAdmin(ctx)).toBe(false)
  })
})
