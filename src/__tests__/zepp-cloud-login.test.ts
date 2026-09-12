import { describe, it, expect, vi } from 'vitest'
import {
  aesEncrypt,
  buildTokensPayload,
  parseTokenRedirect,
  buildLoginPayload,
  parseLoginTokenInfo,
  zeppCloudLogin,
  type ZeppLoginDeps,
} from '../web/zepp/cloud-login.js'
import { ZeppAuthError } from '../web/zepp/puller.js'

// Golden AES-128-CBC vector, computed independently with openssl AND node crypto against the
// reference key/iv (huami-token ZEPP_ENCRYPTION_PARAMS). If our cipher drifts, this fails.
//   printf '<plaintext>' | openssl enc -aes-128-cbc -K <hex(xeNtBVqzDc6tuNTh)> -iv <hex(MAAAYAAAAAAAAABg)> | base64
const GOLDEN_PLAINTEXT = 'emailOrPhone=test%40example.com&state=REDIRECTION&password=hunter2'
const GOLDEN_B64 = 'aSasv+PH1i7WpQxdXPdT7+J384B66Cys2nJ2V8sFXss18OKIAF4uhikyOMFCmC3C6bYaoFQtvoi4fO/OIkisid2zfnnccgaAsnOn2/J7nQo='

describe('aesEncrypt', () => {
  it('matches the reference AES-128-CBC/PKCS7 golden vector byte-for-byte', () => {
    expect(aesEncrypt(GOLDEN_PLAINTEXT).toString('base64')).toBe(GOLDEN_B64)
  })
})

describe('buildTokensPayload', () => {
  it('form-encodes the credential fields in app order with token=access&token=refresh', () => {
    const s = buildTokensPayload('test@example.com', 'hunter2', 'us-west-2', 'US')
    expect(s).toContain('emailOrPhone=test%40example.com')
    expect(s).toContain('password=hunter2')
    expect(s).toContain('client_id=HuaMi')
    expect(s).toContain('token=access')
    expect(s).toContain('token=refresh')
    expect(s).toContain('region=us-west-2')
    expect(s).toContain('country_code=US')
  })
})

describe('parseTokenRedirect', () => {
  it('extracts access and refresh from the 303 Location query', () => {
    const loc = 'https://s3-us-west-2.amazonaws.com/hm-registration/successsignin.html?region=us-west-2&access=ACC123&refresh=REF456&country_code=US'
    expect(parseTokenRedirect(loc)).toEqual({ access: 'ACC123', refresh: 'REF456' })
  })

  it('throws ZeppAuthError when the redirect carries no tokens (bad credentials)', () => {
    expect(() => parseTokenRedirect('https://example.com/fail?error=invalid')).toThrow(ZeppAuthError)
  })

  it('throws ZeppAuthError on an unparseable location', () => {
    expect(() => parseTokenRedirect('not a url')).toThrow(ZeppAuthError)
  })
})

describe('buildLoginPayload', () => {
  it('carries the access code, device id and the access_token grant', () => {
    const s = buildLoginPayload('ACC123', 'dev-uuid', 'US')
    expect(s).toContain('code=ACC123')
    expect(s).toContain('device_id=dev-uuid')
    expect(s).toContain('grant_type=access_token')
    expect(s).toContain('app_name=com.huami.midong')
    expect(s).toContain('device_model=android_phone')
  })
})

describe('parseLoginTokenInfo', () => {
  it('extracts app_token, user_id (as string) and login_token from token_info', () => {
    const body = { token_info: { app_token: 'APP789', login_token: 'LOG012', user_id: 7054735479 } }
    expect(parseLoginTokenInfo(body)).toEqual({ appToken: 'APP789', userId: '7054735479', loginToken: 'LOG012' })
  })

  it('throws ZeppAuthError when app_token is missing', () => {
    expect(() => parseLoginTokenInfo({ token_info: { user_id: 1 } })).toThrow(ZeppAuthError)
  })

  it('throws ZeppAuthError when user_id is missing', () => {
    expect(() => parseLoginTokenInfo({ token_info: { app_token: 'X' } })).toThrow(ZeppAuthError)
  })
})

// --- orchestration: two-step login with an injected fetch ---

function redirectResponse(location: string | null, status = 303): Response {
  return {
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'location' ? location : null) },
  } as unknown as Response
}

function jsonResponse(body: unknown, status = 200): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response
}

describe('zeppCloudLogin', () => {
  function makeDeps(fetchImpl: ReturnType<typeof vi.fn>): ZeppLoginDeps {
    return { fetch: fetchImpl as unknown as typeof globalThis.fetch, deviceId: 'fixed-dev-id' }
  }

  it('logs in end-to-end and returns a fresh app_token + user_id', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse('https://cb/success?access=ACC123&refresh=REF456'))
      .mockResolvedValueOnce(jsonResponse({ token_info: { app_token: 'FRESH_APP', login_token: 'LOG', user_id: 7054735479 } }))
    const result = await zeppCloudLogin('test@example.com', 'hunter2', makeDeps(fetchMock))
    expect(result).toEqual({ appToken: 'FRESH_APP', userId: '7054735479', loginToken: 'LOG' })
  })

  it('sends an encrypted (non-plaintext) body and keeps the 303 (redirect:manual)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse('https://cb/success?access=ACC123&refresh=REF456'))
      .mockResolvedValueOnce(jsonResponse({ token_info: { app_token: 'A', user_id: 1 } }))
    await zeppCloudLogin('test@example.com', 'hunter2', makeDeps(fetchMock))
    const [, opts] = fetchMock.mock.calls[0]
    expect(opts.redirect).toBe('manual')
    expect(opts.body).toBeInstanceOf(Uint8Array)
    const bodyBuf = Buffer.from(opts.body as Uint8Array)
    // the raw credential must not appear in the encrypted body
    expect(bodyBuf.toString('utf8')).not.toContain('hunter2')
    expect(bodyBuf.toString('base64')).toBe(aesEncrypt(buildTokensPayload('test@example.com', 'hunter2', 'us-west-2', 'US')).toString('base64'))
    // step 2 targets the login endpoint
    expect(fetchMock.mock.calls[1][0]).toContain('/v2/client/login')
  })

  it('throws ZeppAuthError when step 1 does not return 303', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(redirectResponse(null, 401))
    await expect(zeppCloudLogin('e', 'p', makeDeps(fetchMock))).rejects.toBeInstanceOf(ZeppAuthError)
  })

  it('throws ZeppAuthError when step 2 does not return 200', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse('https://cb/s?access=ACC&refresh=REF'))
      .mockResolvedValueOnce(jsonResponse({}, 400))
    await expect(zeppCloudLogin('e', 'p', makeDeps(fetchMock))).rejects.toBeInstanceOf(ZeppAuthError)
  })
})
