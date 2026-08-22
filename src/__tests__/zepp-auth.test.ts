import { describe, it, expect, vi } from 'vitest'
import { zeppLogin, zeppRefresh, isTokenExpired, type ZeppAuthDeps } from '../web/zepp/auth.js'

function makeDeps(over: Partial<ZeppAuthDeps> & { fetchResponse?: object; fetchStatus?: number } = {}): ZeppAuthDeps {
  const { fetchResponse = {}, fetchStatus = 200, ...rest } = over
  return {
    loginUrl: 'https://auth.example.com/login',
    refreshUrl: 'https://auth.example.com/refresh',
    fetch: vi.fn(async () => ({
      ok: fetchStatus >= 200 && fetchStatus < 300,
      status: fetchStatus,
      json: async () => fetchResponse,
    } as Response)),
    ...rest,
  }
}

describe('zeppLogin', () => {
  it('returns tokens on successful login', async () => {
    const deps = makeDeps({
      fetchResponse: { token_info: { access_token: 'acc123', refresh_token: 'ref456', expired_in: 3600 } },
    })
    const tokens = await zeppLogin({ email: 'test@test.com', password: 'pass' }, deps)
    expect(tokens.accessToken).toBe('acc123')
    expect(tokens.refreshToken).toBe('ref456')
    expect(tokens.expiresAt).toBeGreaterThan(Date.now())
  })

  it('throws auth_fail on non-200 response', async () => {
    const deps = makeDeps({ fetchStatus: 401, fetchResponse: { message: 'invalid credentials' } })
    await expect(zeppLogin({ email: 'x', password: 'y' }, deps)).rejects.toMatchObject({ type: 'auth_fail' })
  })

  it('throws auth_fail on missing token in body', async () => {
    const deps = makeDeps({ fetchResponse: { token_info: {} } })
    await expect(zeppLogin({ email: 'x', password: 'y' }, deps)).rejects.toMatchObject({ type: 'auth_fail' })
  })

  it('posts to loginUrl with email and password', async () => {
    const deps = makeDeps({
      fetchResponse: { token_info: { access_token: 'a', refresh_token: 'b', expired_in: 3600 } },
    })
    await zeppLogin({ email: 'me@test.com', password: 'secret' }, deps)
    const [url, opts] = (deps.fetch as any).mock.calls[0]
    expect(url).toBe('https://auth.example.com/login')
    const body = JSON.parse(opts.body)
    expect(body.email ?? body.login).toMatch(/me@test\.com/)
  })
})

describe('zeppRefresh', () => {
  it('returns new tokens on successful refresh', async () => {
    const deps = makeDeps({
      fetchResponse: { token_info: { access_token: 'new_acc', refresh_token: 'new_ref', expired_in: 3600 } },
    })
    const tokens = await zeppRefresh('old_ref', deps)
    expect(tokens.accessToken).toBe('new_acc')
    expect(tokens.refreshToken).toBe('new_ref')
  })

  it('throws auth_fail on refresh 401', async () => {
    const deps = makeDeps({ fetchStatus: 401 })
    await expect(zeppRefresh('bad_ref', deps)).rejects.toMatchObject({ type: 'auth_fail' })
  })
})

describe('isTokenExpired', () => {
  it('returns true when expiresAt is in the past', () => {
    expect(isTokenExpired({ accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() - 1000 })).toBe(true)
  })

  it('returns false when expiresAt is in the future (with margin)', () => {
    expect(isTokenExpired({ accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() + 10 * 60 * 1000 })).toBe(false)
  })

  it('returns true when expiresAt is absent', () => {
    expect(isTokenExpired({ accessToken: 'x', refreshToken: 'y' })).toBe(true)
  })
})
