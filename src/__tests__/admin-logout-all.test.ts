import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const TEST_DIR = '/tmp/test-admin-logout-all'
const SECRET_PATH = join(TEST_DIR, 'store', '.dashboard-session-secret')
const REVOKED_PATH = join(TEST_DIR, 'store', '.dashboard-revoked-sessions.json')

// Redirect PROJECT_ROOT so dashboard-auth writes under /tmp, never the real store.
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, PROJECT_ROOT: TEST_DIR }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

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

describe('POST /api/admin/logout-all', () => {
  it('invalidates every active session by rotating the session secret', async () => {
    const { tryHandleAdmin } = await import('../web/routes/admin.js')
    const { createSession, verifySession } = await import('../web/dashboard-auth.js')

    // A session minted under the current secret verifies fine...
    const cookie = createSession()
    expect(verifySession(cookie).valid).toBe(true)

    const { ctx, getResponse } = makeCtx('/api/admin/logout-all', 'POST')
    const handled = await tryHandleAdmin(ctx)

    expect(handled).toBe(true)
    const { status, body } = getResponse()
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    // No secret returned in the body.
    expect(body.token).toBeUndefined()

    // ...and is now signature-rejected: a fresh secret was generated.
    const after = verifySession(cookie)
    expect(after.valid).toBe(false)
    expect(after.expired).toBe(false)

    // The secret file was (re)written and the revocation list reset to empty.
    expect(existsSync(SECRET_PATH)).toBe(true)
    expect(JSON.parse(readFileSync(REVOKED_PATH, 'utf-8'))).toEqual({})

    // A NEW session minted after the rotation verifies under the new secret.
    expect(verifySession(createSession()).valid).toBe(true)
  })

  it('GET on the logout-all path is not handled (POST-only)', async () => {
    const { tryHandleAdmin } = await import('../web/routes/admin.js')
    const { ctx } = makeCtx('/api/admin/logout-all', 'GET')
    expect(await tryHandleAdmin(ctx)).toBe(false)
  })
})
