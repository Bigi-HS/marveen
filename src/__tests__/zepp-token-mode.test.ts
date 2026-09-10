import { describe, it, expect, vi } from 'vitest'
import { readZeppCredsOrToken, resolveDefaultCredsPath, type ZeppCredsOrToken } from '../web/zepp/creds-reader.js'
import { zeppLoginOrToken } from '../web/zepp/auth.js'
import { pullSleep, regionToApiBase, netSleepMin, type ZeppPullDeps } from '../web/zepp/puller.js'
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

describe('creds-reader apptoken shape (card 8001dd41)', () => {
  it('parses {apptoken,userid,region} into token mode with all fields', () => {
    const { credFile, cleanup } = setup()
    writeFileSync(credFile, JSON.stringify({ apptoken: 'APPTOK123', userid: '7054735479', region: 'de2' }))
    expect(readZeppCredsOrToken(credFile)).toEqual({ mode: 'token', token: 'APPTOK123', userid: '7054735479', region: 'de2' })
    cleanup()
  })
})

describe('resolveDefaultCredsPath (ZEPP_CREDS_PATH override)', () => {
  it('uses ZEPP_CREDS_PATH when set', () => {
    expect(resolveDefaultCredsPath({ ZEPP_CREDS_PATH: '/home/domin/.zepp-creds.json' } as any))
      .toBe('/home/domin/.zepp-creds.json')
  })
  it('falls back to store/zepp/.creds.json when unset or blank', () => {
    expect(resolveDefaultCredsPath({} as any)).toMatch(/store[/\\]zepp[/\\]\.creds\.json$/)
    expect(resolveDefaultCredsPath({ ZEPP_CREDS_PATH: '   ' } as any)).toMatch(/store[/\\]zepp/)
  })
})

describe('puller de2/apptoken wiring (card 8001dd41)', () => {
  it('regionToApiBase maps de2 to the zepp.com host', () => {
    expect(regionToApiBase('de2')).toBe('https://api-mifit-de2.zepp.com')
  })
  it('netSleepMin sums asleep stages, excludes awake', () => {
    expect(netSleepMin({ deep: 84, light: 308, rem: 0, awake: 90 })).toBe(392)
    expect(netSleepMin(undefined)).toBeUndefined()
  })

  function capturing(over: Partial<ZeppPullDeps>) {
    const calls: Array<{ url: string; init: any }> = []
    const deps: ZeppPullDeps = {
      apiBaseUrl: 'https://api-mifit-de2.zepp.com',
      accessToken: 'TOK',
      fetch: vi.fn(async (url: string, init: any) => {
        calls.push({ url, init })
        return { ok: true, status: 200, json: async () => ({ data: { sleep_duration: 25200, sleep_stages: [] } }) } as Response
      }) as unknown as typeof fetch,
      ...over,
    }
    return { deps, calls }
  }

  it('apptoken style sends the apptoken header (not Bearer) + userid param', async () => {
    const { deps, calls } = capturing({ authStyle: 'apptoken', userid: '7054735479' })
    await pullSleep('2026-09-09', deps)
    expect(calls[0].init.headers.apptoken).toBe('TOK')
    expect(calls[0].init.headers.Authorization).toBeUndefined()
    expect(calls[0].url).toContain('userid=7054735479')
  })

  it('default (bearer) style keeps Authorization: Bearer and no userid', async () => {
    const { deps, calls } = capturing({})
    await pullSleep('2026-09-09', deps)
    expect(calls[0].init.headers.Authorization).toBe('Bearer TOK')
    expect(calls[0].init.headers.apptoken).toBeUndefined()
    expect(calls[0].url).not.toContain('userid=')
  })
})
