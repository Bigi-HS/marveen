import { describe, it, expect, vi } from 'vitest'
import { readZeppCredsOrToken, type ZeppCredsOrToken } from '../web/zepp/creds-reader.js'
import { zeppLoginOrToken } from '../web/zepp/auth.js'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TMP = join(tmpdir(), `zepp-token-test-${process.pid}`)

function setup() {
  mkdirSync(TMP, { recursive: true })
  return {
    credFile: join(TMP, '.creds.json'),
    cleanup: () => rmSync(TMP, { recursive: true, force: true }),
  }
}

describe('creds-reader token mode', () => {
  it('reads email+password creds (existing mode)', () => {
    const { credFile, cleanup } = setup()
    writeFileSync(credFile, JSON.stringify({ email: 'a@b.com', password: 'secret' }))
    const result = readZeppCredsOrToken(credFile)
    expect(result.mode).toBe('password')
    if (result.mode === 'password') {
      expect(result.email).toBe('a@b.com')
      expect(result.password).toBe('secret')
    }
    cleanup()
  })

  it('reads token-only creds (new mode)', () => {
    const { credFile, cleanup } = setup()
    writeFileSync(credFile, JSON.stringify({ token: 'some-access-token-xyz' }))
    const result = readZeppCredsOrToken(credFile)
    expect(result.mode).toBe('token')
    if (result.mode === 'token') {
      expect(result.token).toBe('some-access-token-xyz')
    }
    cleanup()
  })

  it('throws descriptive error when file is missing', () => {
    expect(() => readZeppCredsOrToken('/nonexistent/path/.creds.json')).toThrow(/not found/)
  })

  it('throws when file has neither token nor email+password', () => {
    const { credFile, cleanup } = setup()
    writeFileSync(credFile, JSON.stringify({ foo: 'bar' }))
    expect(() => readZeppCredsOrToken(credFile)).toThrow(/token|email|password/i)
    cleanup()
  })
})

describe('zeppLoginOrToken', () => {
  it('returns token-mode tokens directly without calling login', async () => {
    const loginFn = vi.fn()
    const creds: ZeppCredsOrToken = { mode: 'token', token: 'direct-token-abc' }
    const result = await zeppLoginOrToken(creds, { loginUrl: '', refreshUrl: '', fetch: loginFn as any })
    expect(result.accessToken).toBe('direct-token-abc')
    expect(loginFn).not.toHaveBeenCalled()
  })

  it('calls zeppLogin for password-mode creds', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ token_info: { access_token: 'acc', refresh_token: 'ref', expired_in: 3600 } }),
    }))
    const creds: ZeppCredsOrToken = { mode: 'password', email: 'a@b.com', password: 'pw' }
    const result = await zeppLoginOrToken(creds, { loginUrl: 'http://x', refreshUrl: '', fetch: mockFetch as any })
    expect(result.accessToken).toBe('acc')
    expect(mockFetch).toHaveBeenCalledOnce()
  })
})
