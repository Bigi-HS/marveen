import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const TEST_DIR = '/tmp/test-dashboard-auth-gate'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, PROJECT_ROOT: '/tmp/test-dashboard-auth-gate' }
})

// Pin the access token so the test controls the login secret.
const TOKEN = 'a'.repeat(64)
process.env.DASHBOARD_TOKEN = TOKEN

import {
  getDashboardToken,
  checkBearerToken,
  createSession,
  verifySession,
  revokeSession,
  parseCookies,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  __resetSessionStateForTests,
} from '../web/dashboard-auth.js'

// A faithful, minimal re-implementation of the web.ts auth region: login,
// logout, and the cookie-OR-bearer gate. It uses the REAL session functions so
// the integration (cookie issuance -> gate acceptance -> revocation) is
// exercised without booting the monitor-heavy full server.
function buildServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const path = url.pathname
    const method = req.method || 'GET'
    const cookies = parseCookies(req.headers.cookie)
    const sessionValue = cookies[SESSION_COOKIE_NAME]
    const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim()
    const isHttps = forwardedProto === 'https'
    const hasValidSession = () => verifySession(sessionValue).valid
    const hasValidBearer = () => checkBearerToken(req.headers.authorization, getDashboardToken())

    if (path === '/api/auth/login' && method === 'POST') {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      let token = ''
      try { token = JSON.parse(Buffer.concat(chunks).toString('utf-8')).token ?? '' } catch { token = '' }
      if (!checkBearerToken(`Bearer ${token}`, getDashboardToken())) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid token' }))
        return
      }
      const cookie = [
        `${SESSION_COOKIE_NAME}=${createSession()}`,
        'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
        ...(isHttps ? ['Secure'] : []),
      ].join('; ')
      res.setHeader('Set-Cookie', cookie)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      revokeSession(sessionValue)
      res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`)
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

// Extract the gd_session value from a Set-Cookie header for replay.
function cookieFromSetCookie(setCookie: string): string {
  return setCookie.split(';')[0]
}

beforeAll(async () => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(join(TEST_DIR, 'store'), { recursive: true })
  server = buildServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`
})

afterAll(() => {
  server?.close()
})

beforeEach(() => {
  __resetSessionStateForTests()
})

describe('POST /api/auth/login', () => {
  it('rejects a wrong token with 401 and no cookie', async () => {
    const r = await req('POST', '/api/auth/login', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'wrong' }),
    })
    expect(r.status).toBe(401)
    expect(r.setCookie).toBeUndefined()
  })

  it('rejects an empty/malformed body with 401', async () => {
    const r = await req('POST', '/api/auth/login', {
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(r.status).toBe(401)
  })

  it('accepts the correct token and sets an HttpOnly SameSite=Strict cookie', async () => {
    const r = await req('POST', '/api/auth/login', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    expect(r.setCookie).toBeTruthy()
    expect(r.setCookie).toContain(`${SESSION_COOKIE_NAME}=`)
    expect(r.setCookie).toContain('HttpOnly')
    expect(r.setCookie).toContain('SameSite=Strict')
    expect(r.setCookie).toContain('Path=/')
    expect(r.setCookie).toContain(`Max-Age=${SESSION_MAX_AGE_SECONDS}`)
    // No X-Forwarded-Proto: plain HTTP, so no Secure flag.
    expect(r.setCookie).not.toContain('Secure')
  })

  it('adds Secure when X-Forwarded-Proto is https (Tailscale Serve)', async () => {
    const r = await req('POST', '/api/auth/login', {
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ token: TOKEN }),
    })
    expect(r.status).toBe(200)
    expect(r.setCookie).toContain('Secure')
  })
})

describe('auth gate (cookie OR bearer)', () => {
  it('rejects a protected route with no credentials', async () => {
    const r = await req('GET', '/api/anything')
    expect(r.status).toBe(401)
  })

  it('accepts a protected route with the bearer header (backward-compat)', async () => {
    const r = await req('GET', '/api/anything', { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(r.status).toBe(200)
  })

  it('rejects a wrong bearer header', async () => {
    const r = await req('GET', '/api/anything', { headers: { Authorization: 'Bearer nope' } })
    expect(r.status).toBe(401)
  })

  it('accepts a protected route with a valid session cookie', async () => {
    const login = await req('POST', '/api/auth/login', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    })
    const cookie = cookieFromSetCookie(login.setCookie!)
    const r = await req('GET', '/api/anything', { headers: { Cookie: cookie } })
    expect(r.status).toBe(200)
  })

  it('rejects a forged/garbage cookie', async () => {
    const r = await req('GET', '/api/anything', { headers: { Cookie: `${SESSION_COOKIE_NAME}=forged` } })
    expect(r.status).toBe(401)
  })
})

describe('POST /api/auth/logout', () => {
  it('revokes the session so the cookie stops working', async () => {
    const login = await req('POST', '/api/auth/login', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    })
    const cookie = cookieFromSetCookie(login.setCookie!)
    expect((await req('GET', '/api/anything', { headers: { Cookie: cookie } })).status).toBe(200)

    const out = await req('POST', '/api/auth/logout', { headers: { Cookie: cookie } })
    expect(out.status).toBe(200)
    expect(out.setCookie).toContain('Max-Age=0')

    expect((await req('GET', '/api/anything', { headers: { Cookie: cookie } })).status).toBe(401)
  })
})
