import { describe, it, expect } from 'vitest'
import {
  refreshAccessToken,
  AccessTokenProvider,
  OAUTH_TOKEN_URL,
  type FetchLike,
  type GoogleClientCreds,
} from '../mcp/google-oauth.js'

const CREDS: GoogleClientCreds = {
  clientId: 'cid',
  clientSecret: 'secret',
  refreshToken: 'rtok',
}

describe('refreshAccessToken', () => {
  it('posts the refresh-token grant and returns token + computed expiry', async () => {
    let seenUrl = ''
    let seenBody = ''
    const fetchFn: FetchLike = async (url, init) => {
      seenUrl = url
      seenBody = init?.body ?? ''
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'AT', expires_in: 3600 }),
        text: async () => '',
      }
    }
    const tok = await refreshAccessToken(CREDS, 1_000_000, fetchFn)
    expect(seenUrl).toBe(OAUTH_TOKEN_URL)
    expect(seenBody).toContain('grant_type=refresh_token')
    expect(seenBody).toContain('refresh_token=rtok')
    expect(seenBody).toContain('client_id=cid')
    expect(tok.token).toBe('AT')
    expect(tok.expiresAt).toBe(1_000_000 + 3600 * 1000)
  })

  it('defaults expiry to 3600s when expires_in is missing', async () => {
    const fetchFn: FetchLike = async () => ({
      ok: true, status: 200, json: async () => ({ access_token: 'AT' }), text: async () => '',
    })
    const tok = await refreshAccessToken(CREDS, 0, fetchFn)
    expect(tok.expiresAt).toBe(3600 * 1000)
  })

  it('throws on a non-ok response and on a missing access_token', async () => {
    const bad: FetchLike = async () => ({
      ok: false, status: 400, json: async () => ({}), text: async () => 'invalid_grant',
    })
    await expect(refreshAccessToken(CREDS, 0, bad)).rejects.toThrow(/token refresh failed: 400/)
    const noTok: FetchLike = async () => ({
      ok: true, status: 200, json: async () => ({}), text: async () => '',
    })
    await expect(refreshAccessToken(CREDS, 0, noTok)).rejects.toThrow(/no access_token/)
  })
})

describe('AccessTokenProvider', () => {
  it('caches the token until it is within the skew of expiry, then refreshes', async () => {
    let calls = 0
    let now = 0
    const fetchFn: FetchLike = async () => {
      calls++
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: `AT${calls}`, expires_in: 3600 }),
        text: async () => '',
      }
    }
    const p = new AccessTokenProvider(CREDS, () => now, fetchFn, 60_000)

    expect(await p.get()).toBe('AT1') // first call refreshes
    now = 1000
    expect(await p.get()).toBe('AT1') // still fresh, no new fetch
    expect(calls).toBe(1)

    now = 3600 * 1000 - 30_000 // within 60s skew of expiry
    expect(await p.get()).toBe('AT2') // refreshes
    expect(calls).toBe(2)
  })
})
