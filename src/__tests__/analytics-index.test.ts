/**
 * Orchestrator tests for card 6498275e analytics OAuth.
 * Feature flag OFF by default. Token null -> not-consented, no throw.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../analytics/tokens.js', () => ({
  loadGoogleTokenPath: vi.fn(() => null),
  loadTwitchTokenPath: vi.fn(() => null),
}))

import { loadGoogleTokenPath, loadTwitchTokenPath } from '../analytics/tokens.js'
import { pull, type AnalyticsResult } from '../analytics/index.js'

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> | void {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    const r = fn()
    if (r instanceof Promise) {
      return r.finally(() => {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k]
          else process.env[k] = v
        }
      })
    }
    return r
  } finally {
    if (!(fn() instanceof Promise)) {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env['ANALYTICS_OAUTH_ENABLED']
})

afterEach(() => {
  delete process.env['ANALYTICS_OAUTH_ENABLED']
})

describe('pull() -- feature flag', () => {
  it('returns not-consented when flag is OFF (default)', async () => {
    delete process.env['ANALYTICS_OAUTH_ENABLED']
    const result = await pull()
    expect(result.status).toBe('disabled')
    expect(result.data).toBeNull()
  })

  it('returns not-consented when flag is explicitly false', async () => {
    process.env['ANALYTICS_OAUTH_ENABLED'] = 'false'
    const result = await pull()
    expect(result.status).toBe('disabled')
    expect(result.data).toBeNull()
  })

  it('returns not-consented when flag is "0"', async () => {
    process.env['ANALYTICS_OAUTH_ENABLED'] = '0'
    const result = await pull()
    expect(result.status).toBe('disabled')
    expect(result.data).toBeNull()
  })

  it('does NOT throw when flag is off', async () => {
    delete process.env['ANALYTICS_OAUTH_ENABLED']
    await expect(pull()).resolves.not.toThrow()
  })
})

describe('pull() -- token null (not-consented)', () => {
  it('returns not-consented when Google token path is null', async () => {
    process.env['ANALYTICS_OAUTH_ENABLED'] = 'true'
    vi.mocked(loadGoogleTokenPath).mockReturnValue(null)
    vi.mocked(loadTwitchTokenPath).mockReturnValue(null)
    const result = await pull()
    expect(result.status).toBe('not-consented')
    expect(result.data).toBeNull()
  })

  it('does NOT throw when token is null', async () => {
    process.env['ANALYTICS_OAUTH_ENABLED'] = 'true'
    vi.mocked(loadGoogleTokenPath).mockReturnValue(null)
    vi.mocked(loadTwitchTokenPath).mockReturnValue(null)
    await expect(pull()).resolves.not.toThrow()
  })
})

describe('pull() -- result shape', () => {
  it('disabled result has typed shape', async () => {
    delete process.env['ANALYTICS_OAUTH_ENABLED']
    const result: AnalyticsResult = await pull()
    expect(result).toHaveProperty('status')
    expect(result).toHaveProperty('data')
  })
})
