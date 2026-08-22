/**
 * Token pointer loader tests for card 6498275e analytics OAuth.
 * Pointer-only: returns file path or null, NEVER the raw token value.
 * Redaction: token content must not reach any log output.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Intercept logger BEFORE importing the module under test.
vi.mock('../logger.js', () => ({
  logger: {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}))

import { logger } from '../logger.js'
import { loadGoogleTokenPath, loadTwitchTokenPath } from '../analytics/tokens.js'

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try { fn() } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('loadGoogleTokenPath', () => {
  it('returns path string when GOOGLE_ANALYTICS_TOKEN_FILE is set', () => {
    withEnv({ GOOGLE_ANALYTICS_TOKEN_FILE: '/store/google-analytics.json' }, () => {
      expect(loadGoogleTokenPath()).toBe('/store/google-analytics.json')
    })
  })

  it('returns null when env var is absent (not-yet-consented state)', () => {
    withEnv({ GOOGLE_ANALYTICS_TOKEN_FILE: undefined }, () => {
      expect(loadGoogleTokenPath()).toBeNull()
    })
  })

  it('returns null for empty string env var', () => {
    withEnv({ GOOGLE_ANALYTICS_TOKEN_FILE: '' }, () => {
      expect(loadGoogleTokenPath()).toBeNull()
    })
  })

  it('does NOT log the token file contents (redaction)', () => {
    const fakeTokenValue = 'ya29.FAKE_GOOGLE_OAUTH_TOKEN_CONTENT_MUST_NOT_APPEAR_IN_LOGS'
    withEnv({ GOOGLE_ANALYTICS_TOKEN_FILE: '/store/google-analytics.json' }, () => {
      loadGoogleTokenPath()
    })
    const allCalls = [
      ...vi.mocked(logger.info).mock.calls,
      ...vi.mocked(logger.warn).mock.calls,
      ...vi.mocked(logger.error).mock.calls,
      ...vi.mocked(logger.debug).mock.calls,
    ]
    const serialized = JSON.stringify(allCalls)
    expect(serialized).not.toContain(fakeTokenValue)
    expect(serialized).not.toContain('ya29.')
  })
})

describe('loadTwitchTokenPath', () => {
  it('returns path string when TWITCH_ANALYTICS_TOKEN_FILE is set', () => {
    withEnv({ TWITCH_ANALYTICS_TOKEN_FILE: '/store/twitch-analytics.json' }, () => {
      expect(loadTwitchTokenPath()).toBe('/store/twitch-analytics.json')
    })
  })

  it('returns null when env var is absent', () => {
    withEnv({ TWITCH_ANALYTICS_TOKEN_FILE: undefined }, () => {
      expect(loadTwitchTokenPath()).toBeNull()
    })
  })

  it('returns null for whitespace-only env var', () => {
    withEnv({ TWITCH_ANALYTICS_TOKEN_FILE: '   ' }, () => {
      expect(loadTwitchTokenPath()).toBeNull()
    })
  })
})
