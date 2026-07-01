/**
 * Scope minimalism assertions for card 6498275e analytics OAuth.
 * Every scope MUST match readonly|:read: -- no write, no monetary.
 */
import { describe, it, expect } from 'vitest'
import { GOOGLE_SCOPES, TWITCH_SCOPES, TWITCH_OPTIONAL_SCOPES } from '../analytics/scopes.js'

const READ_ONLY_RE = /readonly|:read:/

describe('GOOGLE_SCOPES', () => {
  it('contains exactly 2 scopes', () => {
    expect(GOOGLE_SCOPES).toHaveLength(2)
  })

  it('every scope is read-only (no write/monetary)', () => {
    for (const scope of GOOGLE_SCOPES) {
      expect(READ_ONLY_RE.test(scope), `scope "${scope}" must match read-only pattern`).toBe(true)
    }
  })

  it('contains yt-analytics.readonly', () => {
    expect(GOOGLE_SCOPES).toContain('https://www.googleapis.com/auth/yt-analytics.readonly')
  })

  it('contains youtube.readonly', () => {
    expect(GOOGLE_SCOPES).toContain('https://www.googleapis.com/auth/youtube.readonly')
  })

  it('does NOT contain monetary scope', () => {
    const hasMoney = GOOGLE_SCOPES.some(s => s.includes('monetary') || s.includes('revenue'))
    expect(hasMoney).toBe(false)
  })

  it('does NOT contain any write scope', () => {
    const hasWrite = GOOGLE_SCOPES.some(s => /\.(upload|write|manage|force)/.test(s) || !READ_ONLY_RE.test(s))
    expect(hasWrite).toBe(false)
  })
})

describe('TWITCH_SCOPES (required)', () => {
  it('contains exactly 2 required scopes', () => {
    expect(TWITCH_SCOPES).toHaveLength(2)
  })

  it('every required scope is read-only', () => {
    for (const scope of TWITCH_SCOPES) {
      expect(READ_ONLY_RE.test(scope), `scope "${scope}" must match read-only pattern`).toBe(true)
    }
  })

  it('contains channel:read:subscriptions', () => {
    expect(TWITCH_SCOPES).toContain('channel:read:subscriptions')
  })

  it('contains moderator:read:followers', () => {
    expect(TWITCH_SCOPES).toContain('moderator:read:followers')
  })
})

describe('TWITCH_OPTIONAL_SCOPES (sub-flag)', () => {
  it('every optional scope is read-only', () => {
    for (const scope of TWITCH_OPTIONAL_SCOPES) {
      expect(READ_ONLY_RE.test(scope), `scope "${scope}" must match read-only pattern`).toBe(true)
    }
  })

  it('analytics:read:games is in optional (NOT required)', () => {
    expect(TWITCH_OPTIONAL_SCOPES).toContain('analytics:read:games')
    expect(TWITCH_SCOPES).not.toContain('analytics:read:games')
  })
})
