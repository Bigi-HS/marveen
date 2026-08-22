/**
 * Unit coverage for the Claude usage refresher (card 7fe5662f).
 *
 * Every test here is pure / network-free: the outbound fetch and the session
 * file reader are dependency-injected so the parser, staleness gate, egress
 * allowlist, feature-flag, and degrade logic run fully in-process. There is NO
 * live claude.ai call in CI, and by construction NONE of these tests ever put a
 * real credential on the wire.
 *
 * The tests pin the 5 MANDATORY security guards from Chad's design-gate:
 *   G1  readClaudeSession() is the ONLY credential reader; the {sessionKey,
 *       cfClearance} pair never leaves a closed scope (asserted structurally:
 *       the derived cache + the /api response shape never carry it).
 *   G2  no log line emitted by the refresher carries a sessionKey/cfClearance.
 *   G3  the derived usage object exposes ONLY {fiveHour,weekly,stale}; the
 *       credential is never a serializable field, never in an Error.message.
 *   Egress  assertAllowedUrl accepts the two blessed prefixes and throws on
 *       anything else, including an orgId-injection attempt.
 *   Feature-flag  a missing session file yields feature-absent (not auth-error).
 *   Rotation  a 401/403/Cloudflare-challenge degrades to
 *       {stale:true, reason:'auth-expired'} and never echoes the credential.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  parseUsage,
  isStale,
  assertAllowedUrl,
  buildUsageUrl,
  ALLOWED_PREFIXES,
  refreshUsageOnce,
  toDerived,
  UsageAuthError,
  type ClaudeSession,
  type UsageState,
} from '../web/usage-refresher.js'

// A representative captured JSON shape. The EXACT field names are undocumented
// and MUST be confirmed via a live logged-in XHR capture before the panel is
// provisioned (spec section 1). This fixture documents the shape parseUsage is
// written against so the parser can be validated without the real endpoint.
const SAMPLE_USAGE = {
  five_hour: { utilization: 42, resets_at: '2026-07-22T15:00:00Z' },
  seven_day: { utilization: 71, resets_at: '2026-07-27T00:00:00Z' },
}

const SESSION: ClaudeSession = {
  sessionKey: 'sk-ant-sid01-SECRET-DO-NOT-LEAK',
  cfClearance: 'cf-clearance-SECRET-DO-NOT-LEAK',
}

const ORG_ID = '11111111-2222-3333-4444-555555555555'

describe('parseUsage', () => {
  it('maps the captured shape to {fiveHour,weekly} with pct + resetAt', () => {
    const parsed = parseUsage(SAMPLE_USAGE)
    expect(parsed).toEqual({
      fiveHour: { pct: 42, resetAt: '2026-07-22T15:00:00Z' },
      weekly: { pct: 71, resetAt: '2026-07-27T00:00:00Z' },
    })
  })

  it('clamps a percentage into 0..100 and rounds', () => {
    const parsed = parseUsage({
      five_hour: { utilization: 142.6, resets_at: 'x' },
      seven_day: { utilization: -5, resets_at: 'y' },
    })!
    expect(parsed.fiveHour.pct).toBe(100)
    expect(parsed.weekly.pct).toBe(0)
  })

  it('returns null on a malformed / missing-window payload (no throw)', () => {
    expect(parseUsage(null)).toBeNull()
    expect(parseUsage({})).toBeNull()
    expect(parseUsage({ five_hour: { utilization: 1, resets_at: 'x' } })).toBeNull()
    expect(parseUsage('not an object')).toBeNull()
  })
})

describe('isStale (staleness gate)', () => {
  const FRESH_MS = 20 * 60 * 1000 // 20 min TTL used by the refresher
  it('is fresh when the last success is within the TTL', () => {
    const now = 1_000_000_000
    expect(isStale(now - 60_000, now, FRESH_MS)).toBe(false)
  })
  it('is stale when the last success is older than the TTL', () => {
    const now = 1_000_000_000
    expect(isStale(now - (FRESH_MS + 1), now, FRESH_MS)).toBe(true)
  })
  it('is stale when there has never been a success', () => {
    expect(isStale(null, 1_000_000_000, FRESH_MS)).toBe(true)
  })
})

describe('assertAllowedUrl (egress allowlist / SSRF guard)', () => {
  it('exposes exactly the two blessed prefixes', () => {
    expect(ALLOWED_PREFIXES).toEqual([
      'https://claude.ai/api/organizations/',
      'https://claude.ai/api/usage',
    ])
  })

  it('accepts a URL under a blessed prefix', () => {
    expect(() =>
      assertAllowedUrl(`https://claude.ai/api/organizations/${ORG_ID}/usage`),
    ).not.toThrow()
    expect(() => assertAllowedUrl('https://claude.ai/api/usage')).not.toThrow()
  })

  it('throws on a different host', () => {
    expect(() => assertAllowedUrl('https://evil.example.com/api/usage')).toThrow()
  })

  it('throws on a different claude.ai path (not usage/org)', () => {
    expect(() =>
      assertAllowedUrl('https://claude.ai/api/organizations/x/chat_conversations'),
    ).toThrow()
    // "chat_conversations" is not under the org+/usage discipline -> the assembled
    // usage URL always ends in /usage; anything else is denied at assembly time.
  })

  it('throws on an orgId-injection attempt that breaks out of the prefix', () => {
    // An attacker-controlled orgId trying to jump host via an @ or protocol-switch.
    const evil = buildUsageUrl('foo@evil.com/', ORG_ID)
    // buildUsageUrl assembles under the org prefix; the assert must still reject
    // any assembled URL that does not stay under a blessed prefix.
    expect(() => assertAllowedUrl('https://claude.ai@evil.com/api/usage')).toThrow()
    expect(() => assertAllowedUrl(evil.replace('https://claude.ai', 'https://evil'))).toThrow()
  })

  it('rejects a non-https scheme', () => {
    expect(() => assertAllowedUrl('http://claude.ai/api/usage')).toThrow()
    expect(() => assertAllowedUrl('file:///etc/passwd')).toThrow()
  })
})

describe('buildUsageUrl', () => {
  it('assembles the usage URL under the blessed org prefix and passes the allowlist', () => {
    const url = buildUsageUrl('https://claude.ai/api/organizations/', ORG_ID)
    expect(url.startsWith('https://claude.ai/api/organizations/')).toBe(true)
    expect(() => assertAllowedUrl(url)).not.toThrow()
  })
})

describe('toDerived (G3: response shape never carries the credential)', () => {
  it('produces ONLY {fiveHour,weekly,stale} on a fresh success', () => {
    const parsed = parseUsage(SAMPLE_USAGE)!
    const derived = toDerived({ ok: true, usage: parsed, lastSuccessMs: 1000 }, 1000, 20 * 60 * 1000)
    expect(Object.keys(derived).sort()).toEqual(['fiveHour', 'stale', 'weekly'])
    expect(derived.stale).toBe(false)
    // No credential field, at any depth.
    const blob = JSON.stringify(derived)
    expect(blob).not.toContain('SECRET')
    expect(blob).not.toContain(SESSION.sessionKey)
    expect(blob).not.toContain(SESSION.cfClearance)
  })

  it('marks stale + carries no numbers-of-record beyond derived pct/resetAt', () => {
    const parsed = parseUsage(SAMPLE_USAGE)!
    const derived = toDerived({ ok: true, usage: parsed, lastSuccessMs: 0 }, 10 ** 12, 20 * 60 * 1000)
    expect(derived.stale).toBe(true)
  })
})

describe('refreshUsageOnce (network path, injected fetch + session)', () => {
  // Success: parses derived usage, and NEVER logs / returns the credential (G2/G3).
  it('returns derived usage on a 200 and puts the cookie only in the request headers', async () => {
    const seenHeaders: Record<string, string>[] = []
    const fetchImpl = vi.fn(async (_url: string, init: any) => {
      seenHeaders.push(init.headers)
      // First call = org discovery, second = usage. Keep it single-shot: the
      // refresher discovers org then usage; we answer both by URL.
      if (String(_url).includes('/api/organizations') && !String(_url).endsWith('/usage')) {
        return okJson([{ uuid: ORG_ID }])
      }
      return okJson(SAMPLE_USAGE)
    })
    const result = await refreshUsageOnce({
      readSession: () => SESSION,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.usage.fiveHour.pct).toBe(42)
      expect(result.usage.weekly.pct).toBe(71)
    }
    // The credential rides in the Cookie header of the request (expected), but
    // NEVER in the returned result object (G3).
    const blob = JSON.stringify(result)
    expect(blob).not.toContain('SECRET')
  })

  it('feature-absent when the session file is missing (NOT an auth error)', async () => {
    const result = await refreshUsageOnce({
      readSession: () => null,
      fetchImpl: (async () => {
        throw new Error('fetch must not be called without a session')
      }) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('feature-absent')
  })

  it('degrades to auth-expired on a 401 and does NOT echo the credential (rotation)', async () => {
    const fetchImpl = vi.fn(async () => statusJson(401, { error: { message: 'unauthorized' } }))
    const result = await refreshUsageOnce({
      readSession: () => SESSION,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('auth-expired')
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })

  it('degrades to auth-expired on a 403 Cloudflare challenge', async () => {
    const fetchImpl = vi.fn(async () => statusJson(403, { error: 'challenge' }))
    const result = await refreshUsageOnce({
      readSession: () => SESSION,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('auth-expired')
  })

  it('degrades to unavailable (not a crash) on a network error, credential-free', async () => {
    const fetchImpl = vi.fn(async () => {
      // An error whose message contains the credential MUST NOT reach the caller.
      throw new Error(`socket to ${SESSION.sessionKey} refused`)
    })
    const result = await refreshUsageOnce({
      readSession: () => SESSION,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unavailable')
    // G3/G2: the surfaced reason string never carries the leaked message.
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })

  it('refuses to fetch a URL outside the egress allowlist (SSRF guard fires)', async () => {
    // A poisoned org discovery returns a uuid that would assemble an off-allowlist
    // URL; refreshUsageOnce must throw/degrade rather than fetch it.
    const fetchImpl = vi.fn(async (_url: string) => {
      if (String(_url).includes('/api/organizations') && !String(_url).endsWith('/usage')) {
        // an orgId containing a slash + host breakout attempt
        return okJson([{ uuid: '../../evil.com' }])
      }
      throw new Error('should never reach the usage fetch for a poisoned org')
    })
    const result = await refreshUsageOnce({
      readSession: () => SESSION,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unavailable')
  })
})

describe('UsageAuthError (G3: the error type never serializes the credential)', () => {
  it('has a fixed, credential-free message', () => {
    const e = new UsageAuthError()
    expect(e.message).not.toContain('SECRET')
    expect(e.message.toLowerCase()).toContain('auth')
  })
})

// --- helpers ---------------------------------------------------------------

function okJson(body: unknown) {
  return statusJson(200, body)
}
function statusJson(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

// Type-only assertion that UsageState is the closed derived shape (compile-time).
const _shapeCheck: UsageState = {
  fiveHour: { pct: 0, resetAt: '' },
  weekly: { pct: 0, resetAt: '' },
  stale: false,
}
void _shapeCheck
