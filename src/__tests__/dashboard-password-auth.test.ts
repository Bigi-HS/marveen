import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const TEST_DIR = '/tmp/test-dashboard-password-auth'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  // Literal (not TEST_DIR) -- vi.mock is hoisted above the const declaration.
  return { ...actual, PROJECT_ROOT: '/tmp/test-dashboard-password-auth' }
})

// Pin the bearer token so the token path stays testable alongside password auth.
const TOKEN = 'b'.repeat(64)
process.env.DASHBOARD_TOKEN = TOKEN

import {
  getDashboardToken,
  checkBearerToken,
  createSession,
  verifySession,
  parseCookies,
  setDashboardCredentials,
  verifyPassword,
  hasPasswordCredentials,
  MIN_PASSWORD_LENGTH,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  __resetSessionStateForTests,
} from '../web/dashboard-auth.js'

const USER = 'dominik'
const PASS = 'correct-horse-battery-staple' // >= MIN_PASSWORD_LENGTH

describe('credential unit functions', () => {
  beforeEach(() => {
    rmSync(join(TEST_DIR, 'store', '.dashboard-credentials.json'), { force: true })
    __resetSessionStateForTests()
  })

  it('reports no credentials before any are set', () => {
    expect(hasPasswordCredentials()).toBe(false)
    expect(verifyPassword(USER, PASS)).toBe(false)
  })

  it('accepts the correct username+password after set', () => {
    setDashboardCredentials(USER, PASS)
    expect(hasPasswordCredentials()).toBe(true)
    expect(verifyPassword(USER, PASS)).toBe(true)
  })

  it('rejects a wrong password', () => {
    setDashboardCredentials(USER, PASS)
    expect(verifyPassword(USER, 'wrong-password-here')).toBe(false)
  })

  it('rejects a wrong username', () => {
    setDashboardCredentials(USER, PASS)
    expect(verifyPassword('attacker', PASS)).toBe(false)
  })

  it('rejects empty inputs', () => {
    setDashboardCredentials(USER, PASS)
    expect(verifyPassword('', '')).toBe(false)
    expect(verifyPassword(USER, '')).toBe(false)
  })

  it('refuses to set a too-short password', () => {
    expect(() => setDashboardCredentials(USER, 'a'.repeat(MIN_PASSWORD_LENGTH - 1))).toThrow()
    expect(hasPasswordCredentials()).toBe(false)
  })

  it('refuses an empty username', () => {
    expect(() => setDashboardCredentials('   ', PASS)).toThrow()
  })

  it('rotates: a new password invalidates the old one', () => {
    setDashboardCredentials(USER, PASS)
    __resetSessionStateForTests()
    const PASS2 = 'a-different-strong-password'
    setDashboardCredentials(USER, PASS2)
    expect(verifyPassword(USER, PASS)).toBe(false)
    expect(verifyPassword(USER, PASS2)).toBe(true)
  })
})

// Minimal faithful re-implementation of the web.ts login region exercising the
// REAL auth functions -- mirrors dashboard-auth-gate.test.ts.
function buildServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const path = url.pathname
    const method = req.method || 'GET'
    const cookies = parseCookies(req.headers.cookie)
    const sessionValue = cookies[SESSION_COOKIE_NAME]
    const hasValidSession = () => verifySession(sessionValue).valid
    const hasValidBearer = () => checkBearerToken(req.headers.authorization, getDashboardToken())

    if (path === '/api/auth/login' && method === 'POST') {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      let token = ''
      let username = ''
      let password = ''
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
        token = parsed.token ?? ''
        username = parsed.username ?? ''
        password = parsed.password ?? ''
      } catch { /* empty */ }
      const tokenOk = token !== '' && checkBearerToken(`Bearer ${token}`, getDashboardToken())
      const passwordOk = (username !== '' || password !== '') && verifyPassword(username, password)
      if (!tokenOk && !passwordOk) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid credentials' }))
        return
      }
      const cookie = [
        `${SESSION_COOKIE_NAME}=${createSession()}`,
        'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
      ].join('; ')
      res.setHeader('Set-Cookie', cookie)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (path.startsWith('/api/')) {
      if (!hasValidSession() && !hasValidBearer()) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, path }))
  })
}

let server: http.Server
let base: string

function req(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: any; setCookie?: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base + path)
    const r = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: opts.headers },
      (resp) => {
        const chunks: Buffer[] = []
        resp.on('data', (c) => chunks.push(c as Buffer))
        resp.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8')
          let body: any = null
          try { body = raw ? JSON.parse(raw) : null } catch { body = raw }
          resolve({ status: resp.statusCode || 0, body, setCookie: resp.headers['set-cookie']?.[0] })
        })
      },
    )
    r.on('error', reject)
    if (opts.body) r.write(opts.body)
    r.end()
  })
}

describe('POST /api/auth/login (username+password)', () => {
  beforeAll(async () => {
    setDashboardCredentials(USER, PASS)
    server = buildServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`
  })
  afterAll(() => server?.close())
  beforeEach(() => __resetSessionStateForTests())

  it('accepts a correct username+password and sets a session cookie', async () => {
    const r = await req('POST', '/api/auth/login', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASS }),
    })
    expect(r.status).toBe(200)
    expect(r.setCookie).toContain(`${SESSION_COOKIE_NAME}=`)
    const cookie = r.setCookie!.split(';')[0]
    const gated = await req('GET', '/api/anything', { headers: { Cookie: cookie } })
    expect(gated.status).toBe(200)
  })

  it('rejects a wrong password with 401 and no cookie', async () => {
    const r = await req('POST', '/api/auth/login', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USER, password: 'nope-nope-nope' }),
    })
    expect(r.status).toBe(401)
    expect(r.setCookie).toBeUndefined()
  })

  it('still accepts the bearer token (backward-compat path)', async () => {
    const r = await req('POST', '/api/auth/login', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    })
    expect(r.status).toBe(200)
    expect(r.setCookie).toContain(`${SESSION_COOKIE_NAME}=`)
  })
})
