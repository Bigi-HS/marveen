import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  buildAuthHeaders,
  apiGet,
  ApiError,
  getToken,
  captureTokenFromUrl,
  parseTokenInput,
  saveToken,
} from './api'

describe('buildAuthHeaders (AC-G5)', () => {
  it('adds a Bearer header when a token is present', () => {
    expect(buildAuthHeaders('abc')).toEqual({ Accept: 'application/json', Authorization: 'Bearer abc' })
  })

  it('omits Authorization when no token (no empty Bearer)', () => {
    expect(buildAuthHeaders(null)).toEqual({ Accept: 'application/json' })
  })
})

describe('getToken', () => {
  beforeEach(() => localStorage.clear())
  it('falls back to localStorage when no env token', () => {
    localStorage.setItem('noa-api-token', 'tok-123')
    expect(getToken()).toBe('tok-123')
  })
  it('returns null when nothing is set', () => {
    expect(getToken()).toBeNull()
  })
})

describe('captureTokenFromUrl -- /v2 deep-link login (hash-based, SEC-112 #929)', () => {
  it('persists and strips a #token= value, returns true', () => {
    const persist = vi.fn()
    const stripUrl = vi.fn()
    expect(captureTokenFromUrl('#token=deeptok', persist, stripUrl)).toBe(true)
    expect(persist).toHaveBeenCalledWith('deeptok')
    expect(stripUrl).toHaveBeenCalledOnce()
  })

  it('does nothing when hash has no token key', () => {
    const persist = vi.fn()
    const stripUrl = vi.fn()
    expect(captureTokenFromUrl('#other=1', persist, stripUrl)).toBe(false)
    expect(persist).not.toHaveBeenCalled()
    expect(stripUrl).not.toHaveBeenCalled()
  })

  it('does nothing for empty string', () => {
    const persist = vi.fn()
    const stripUrl = vi.fn()
    expect(captureTokenFromUrl('', persist, stripUrl)).toBe(false)
    expect(persist).not.toHaveBeenCalled()
  })

  it('ignores an empty #token= (no blank token persisted)', () => {
    const persist = vi.fn()
    expect(captureTokenFromUrl('#token=', persist, vi.fn())).toBe(false)
    expect(persist).not.toHaveBeenCalled()
  })

  it('the default persist path writes to the same key getToken reads', () => {
    localStorage.clear()
    captureTokenFromUrl('#token=fromlink', undefined, vi.fn())
    expect(getToken()).toBe('fromlink')
  })

  it('does NOT capture ?token= from query string (old format deprecated)', () => {
    const persist = vi.fn()
    expect(captureTokenFromUrl('?token=oldformat', persist, vi.fn())).toBe(false)
    expect(persist).not.toHaveBeenCalled()
  })
})

describe('parseTokenInput -- manual connect paste (remote-webview first-run)', () => {
  it('extracts the token from a full pairing URL (#token=)', () => {
    expect(parseTokenInput('https://bigi.tail1a5fa5.ts.net/v2/#token=jwt.aaa.bbb')).toBe('jwt.aaa.bbb')
  })

  it('extracts from a bare #token= fragment', () => {
    expect(parseTokenInput('#token=jwt.aaa.bbb')).toBe('jwt.aaa.bbb')
  })

  it('extracts from a ?token= query param (lenient on paste, unlike the deep-link)', () => {
    expect(parseTokenInput('https://host/v2/?token=jwt.aaa.bbb')).toBe('jwt.aaa.bbb')
  })

  it('accepts a bare raw JWT with no URL wrapper', () => {
    expect(parseTokenInput('jwt.aaa.bbb')).toBe('jwt.aaa.bbb')
  })

  it('trims surrounding whitespace from a pasted token', () => {
    expect(parseTokenInput('  jwt.aaa.bbb\n')).toBe('jwt.aaa.bbb')
  })

  it('returns null for empty / whitespace-only input', () => {
    expect(parseTokenInput('')).toBeNull()
    expect(parseTokenInput('   ')).toBeNull()
  })

  it('returns null for a URL that carries no token', () => {
    expect(parseTokenInput('https://bigi.tail1a5fa5.ts.net/v2/')).toBeNull()
  })

  it('rejects multi-word paste artifacts (a JWT has no spaces)', () => {
    expect(parseTokenInput('token is jwt.aaa.bbb')).toBeNull()
  })
})

describe('saveToken', () => {
  beforeEach(() => localStorage.clear())

  it('writes to the same key getToken reads', () => {
    saveToken('pasted-tok')
    expect(getToken()).toBe('pasted-tok')
  })

  it('does not throw when storage is unavailable', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded')
    })
    expect(() => saveToken('x')).not.toThrow()
    spy.mockRestore()
  })
})

describe('apiGet', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('sends only a GET and returns parsed JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ name: 'dave' }],
    })
    vi.stubGlobal('fetch', fetchMock)

    const data = await apiGet<Array<{ name: string }>>('/api/agents')
    expect(data).toEqual([{ name: 'dave' }])
    expect(fetchMock).toHaveBeenCalledWith('/api/agents', expect.objectContaining({ method: 'GET' }))
  })

  it('throws ApiError carrying the status on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }))
    await expect(apiGet('/api/agents')).rejects.toMatchObject({ name: 'ApiError', status: 401 })
    await expect(apiGet('/api/agents')).rejects.toBeInstanceOf(ApiError)
  })
})
