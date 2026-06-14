import { describe, it, expect } from 'vitest'
import {
  parseClientJson,
  buildAuthUrl,
  exchangeCodeForTokens,
  AUTH_ENDPOINT,
  SCOPES,
} from '../mcp/google-authorize.js'
import { OAUTH_TOKEN_URL, type FetchLike } from '../mcp/google-oauth.js'

describe('parseClientJson', () => {
  it('reads a Desktop-app { installed: {...} } client', () => {
    const raw = JSON.stringify({ installed: { client_id: 'cid', client_secret: 'sec' } })
    expect(parseClientJson(raw)).toEqual({ clientId: 'cid', clientSecret: 'sec' })
  })

  it('also accepts web and flat shapes', () => {
    expect(parseClientJson(JSON.stringify({ web: { client_id: 'a', client_secret: 'b' } })))
      .toEqual({ clientId: 'a', clientSecret: 'b' })
    expect(parseClientJson(JSON.stringify({ client_id: 'a', client_secret: 'b' })))
      .toEqual({ clientId: 'a', clientSecret: 'b' })
  })

  it('throws when client_id/secret are missing', () => {
    expect(() => parseClientJson(JSON.stringify({ installed: { client_id: 'x' } }))).toThrow(
      /missing client_id\/client_secret/,
    )
  })
})

describe('buildAuthUrl', () => {
  it('requests offline access with forced consent and the minimal scopes', () => {
    const u = new URL(buildAuthUrl('cid', 'http://localhost:4117/'))
    expect(`${u.origin}${u.pathname}`).toBe(AUTH_ENDPOINT)
    expect(u.searchParams.get('client_id')).toBe('cid')
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:4117/')
    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('access_type')).toBe('offline')
    expect(u.searchParams.get('prompt')).toBe('consent')
    expect(u.searchParams.get('scope')).toBe(SCOPES.join(' '))
  })

  it('scopes are exactly calendar-readonly + gmail-send (no broader grant)', () => {
    expect(SCOPES).toEqual([
      'https://www.googleapis.com/auth/calendar.events.readonly',
      'https://www.googleapis.com/auth/gmail.send',
    ])
  })
})

describe('exchangeCodeForTokens', () => {
  it('posts the authorization_code grant and returns the refresh token', async () => {
    let seenUrl = ''
    let seenBody = ''
    const fetchFn: FetchLike = async (url, init) => {
      seenUrl = url
      seenBody = init?.body ?? ''
      return {
        ok: true,
        status: 200,
        json: async () => ({ refresh_token: 'RT', access_token: 'AT' }),
        text: async () => '',
      }
    }
    const out = await exchangeCodeForTokens(
      { clientId: 'cid', clientSecret: 'sec' },
      'CODE',
      'http://localhost:4117/',
      fetchFn,
    )
    expect(seenUrl).toBe(OAUTH_TOKEN_URL)
    expect(seenBody).toContain('grant_type=authorization_code')
    expect(seenBody).toContain('code=CODE')
    expect(out).toEqual({ refreshToken: 'RT', accessToken: 'AT' })
  })

  it('throws a clear error when no refresh_token comes back', async () => {
    const fetchFn: FetchLike = async () => ({
      ok: true, status: 200, json: async () => ({ access_token: 'AT' }), text: async () => '',
    })
    await expect(
      exchangeCodeForTokens({ clientId: 'c', clientSecret: 's' }, 'CODE', 'http://localhost/', fetchFn),
    ).rejects.toThrow(/no refresh_token/)
  })

  it('throws on a non-ok exchange', async () => {
    const fetchFn: FetchLike = async () => ({
      ok: false, status: 400, json: async () => ({}), text: async () => 'invalid_grant',
    })
    await expect(
      exchangeCodeForTokens({ clientId: 'c', clientSecret: 's' }, 'CODE', 'http://localhost/', fetchFn),
    ).rejects.toThrow(/code exchange failed: 400/)
  })
})
