import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildAuthHeaders, apiGet, ApiError, getToken } from './api'

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
